#!/usr/bin/env python3
"""
Thesis verification harness.

Runs the recorded test matrix (T01..T10) against the built extension in a
real Chrome, driving freeze/restore through the extension's own message
protocol (the same messages the popup sends), and writes one JSON record per
test plus an aggregated report.md under results/verification/<run-id>/.

Every run — including failures and aborted runs — is recorded. Nothing is
deleted.

Requires the venv python (websocket-client):
  tools/thesis-verify/.venv/bin/python tools/thesis-verify/verify.py run --tests T01,T02

See tools/thesis-verify/README.md for the full test matrix and thresholds.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import statistics
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import websocket  # noqa: F401  (guard: venv required)
except ImportError:
    sys.exit(
        "websocket-client is missing. Run:\n"
        "  python3 -m venv tools/thesis-verify/.venv\n"
        "  tools/thesis-verify/.venv/bin/pip install websocket-client"
    )

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cdp  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
RESULTS = ROOT / "results" / "verification"
PROFILES = Path(__file__).resolve().parent / "profiles"
BENCH = ROOT / "tools" / "memory-bench" / "bench.py"
DIST = ROOT / "dist"

FIXTURE_PORT = 8123
CDP_PORT = 9226

# --- Acceptance thresholds (fixed before running; margin below thesis claims)
THRESHOLDS = {
    "T01_freeze_success_rate": 0.95,      # claim context: freeze must just work
    "T04_element_ratio_max": 1.10,        # no duplicated UI after restore
    "T05_per_tab_mean_pct": 70.0,         # thesis claims 90%; margin kept
    "T05_per_tab_p10_pct": 60.0,
    "T06_aggregate_pct": 50.0,            # thesis claims 80% across 50 tabs
    "T07_overhead_ratio_max": 1.10,       # extension idle cost vs baseline
    "T08_freeze_p95_ms": 2000.0,
    "T08_restore_p95_ms": 5000.0,
    "T08_max_batch_ms": 50.0,             # long-task budget from types.ts
    "T10_slope_pct_per_cycle": 1.0,
}

TEST_NAMES = {
    "T01": "freeze success rate",
    "T02": "byte-exact fidelity after freeze/restore",
    "T03": "restore mode correctness (+ auto-restore)",
    "T04": "no duplicated UI after restore",
    "T05": "per-tab memory saving",
    "T06": "aggregate memory saving across 50 tabs",
    "T07": "extension idle memory overhead",
    "T08": "freeze/restore latency and spikes",
    "T09": "determinism of capture+compression",
    "T10": "stress: 20 freeze/restore cycles, leak check",
}

# --- Page-side helpers (plain JS, evaluated via CDP) -------------------------

SNAPSHOT_JS = r"""
(() => {
  const root = document.documentElement.cloneNode(true);
  // Normalize restore-side mutations so we compare user-visible state only.
  root.querySelectorAll('[data-lto-id]').forEach(e => e.removeAttribute('data-lto-id'));
  root.querySelectorAll('input').forEach(e => e.removeAttribute('value'));
  root.querySelectorAll('textarea').forEach(e => { e.textContent = ''; });
  root.querySelectorAll('option[selected]').forEach(e => e.removeAttribute('selected'));
  const forms = [...document.querySelectorAll('input, textarea, select')].map((el, i) => {
    const tag = el.tagName;
    let v;
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) v = el.checked;
    else if (tag === 'SELECT') v = el.multiple ? [...el.selectedOptions].map(o => o.value) : el.value;
    else v = el.value;
    return { i, tag, type: el.type || '', id: el.id || '', name: el.name || '', v };
  });
  return {
    url: location.href,
    title: document.title,
    html: root.outerHTML,
    forms,
    scroll: [Math.round(window.scrollX), Math.round(window.scrollY)],
    elements: document.querySelectorAll('*').length,
    bodyChildren: document.body ? document.body.children.length : -1,
    ready: document.readyState,
  };
})()
"""

TYPING_JS = r"""
(() => {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('f-name', 'typed-name-42');
  set('f-nick', 'typed-nick-7');
  set('f-pw', 'typed-secret');
  const agree = document.getElementById('f-agree');
  if (agree) agree.checked = false;
  const radios = document.querySelectorAll('input[name="plan"]');
  if (radios[0]) radios[0].checked = true;
  set('f-bio', 'typed bio line one\nline two');
  set('f-country', 'br');
  const langs = document.getElementById('f-langs');
  if (langs) [...langs.options].forEach(o => { o.selected = (o.value === 'pt' || o.value === 'de'); });
  window.scrollTo(0, 1200);
  return true;
})()
"""


def p95(values: list[float]) -> float | None:
    """Nearest-rank p95 — deterministic, no interpolation."""
    clean = sorted(v for v in values if v is not None)
    if not clean:
        return None
    return clean[max(0, -(-len(clean) * 95 // 100) - 1)]


def p10(values: list[float]) -> float | None:
    clean = sorted(v for v in values if v is not None)
    if not clean:
        return None
    return clean[max(0, -(-len(clean) * 10 // 100) - 1)]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- Fixture HTTP server -----------------------------------------------------

class FixtureServer:
    def __init__(self, port: int = FIXTURE_PORT):
        self.port = port
        self.proc: subprocess.Popen | None = None

    def start(self) -> None:
        if self.proc and self.proc.poll() is None:
            return
        self.proc = subprocess.Popen(
            [
                sys.executable, "-m", "http.server", str(self.port),
                "--bind", "127.0.0.1", "--directory", str(FIXTURES),
            ],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        import socket

        for _ in range(50):
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("fixture server did not come up")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None


# --- Memory sampling (reuses bench.py's /proc + smem logic) ------------------

def _load_bench():
    import importlib.util

    spec = importlib.util.spec_from_file_location("lto_bench", BENCH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _smem_table(pids: set[int]) -> dict[int, tuple[int, int]]:
    """One `smem` call for all PIDs -> {pid: (rss_bytes, pss_bytes)}."""
    if not shutil.which("smem") or not pids:
        return {}
    try:
        out = subprocess.run(
            ["smem", "-c", "pid rss pss", "-n"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.splitlines()
    except (OSError, subprocess.SubprocessError):
        return {}
    table = {}
    for line in out[1:]:
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            table[int(parts[0])] = (int(parts[1]) * 1024, int(parts[2]) * 1024)
        except ValueError:
            continue
    return {p: table[p] for p in pids if p in table}


class Sampler:
    """Samples the Chrome process tree; sync snapshots or timed captures."""

    def __init__(self, root_pid: int, bench_mod, interval: float = 0.5):
        self.root_pid = root_pid
        self.bench = bench_mod
        self.interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.samples: list[dict] = []

    def snapshot(self) -> dict:
        pids, all_stats = self.bench.process_tree(self.root_pid)
        table = _smem_table(pids)
        if table:
            rss = sum(v[0] for v in table.values())
            pss = sum(v[1] for v in table.values())
            pid_pss = {pid: v[1] for pid, v in table.items()}
        else:
            rss, pss = self.bench.memory_for(pids)
            pid_pss = {}
        ticks = sum(all_stats[p][1] for p in pids if p in all_stats)
        return {
            "t": time.time(),
            "processes": len(pids),
            "rss": rss,
            "pss": pss,
            "pid_pss": pid_pss,
            "ticks": ticks,
        }

    def average(self, n: int = 3, gap: float = 0.4) -> dict:
        """Average of n snapshots — reduces single-sample noise."""
        snaps = []
        for i in range(n):
            snaps.append(self.snapshot())
            if i < n - 1:
                time.sleep(gap)
        return {
            "pss": int(statistics.fmean(s["pss"] for s in snaps)),
            "rss": int(statistics.fmean(s["rss"] for s in snaps)),
            "processes": snaps[-1]["processes"],
            "pid_pss": snaps[-1]["pid_pss"],
            "snapshots": len(snaps),
        }

    def wait_stable(self, timeout: float = 15.0, tolerance: float = 0.02,
                    min_reads: int = 3, gap: float = 0.5,
                    min_wait: float = 0.0) -> float:
        """Block until total PSS stops moving (teardown finished, no ramp).

        `min_wait` forces a grace period before stability can be accepted —
        Chrome's extension service worker and the offscreen document hold
        transient buffers for ~30 s after their last use (measured: +49 MiB
        on a 50-tab freeze), so measuring too early under-reports the saving.

        Returns the last PSS. Times out into the last reading rather than
        hanging — the caller records whatever happened.
        """
        reads: list[int] = []
        t_start = time.time()
        deadline = t_start + timeout
        while time.time() < deadline:
            reads.append(self.snapshot()["pss"])
            if time.time() - t_start >= min_wait and len(reads) >= min_reads:
                window = reads[-min_reads:]
                spread = max(window) - min(window)
                if spread <= max(window) * tolerance:
                    return window[-1]
            time.sleep(gap)
        return reads[-1] if reads else 0

    def start_capture(self) -> None:
        self.samples = []
        self._stop.clear()

        def loop():
            prev = None
            while not self._stop.is_set():
                s = self.snapshot()
                cpu = None
                if prev is not None:
                    dt = s["t"] - prev["t"]
                    if dt > 0:
                        cpu = (s["ticks"] - prev["ticks"]) / self.bench.CLK_TCK / dt * 100
                s["cpu"] = cpu
                self.samples.append(s)
                prev = s
                time.sleep(self.interval)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def stop_capture(self) -> dict:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=self.interval * 4 + 2)
        cpus = [s["cpu"] for s in self.samples if s.get("cpu") is not None]
        return {
            "samples": len(self.samples),
            "peak_pss": max((s["pss"] for s in self.samples), default=None),
            "peak_rss": max((s["rss"] for s in self.samples), default=None),
            "peak_cpu_pct": max(cpus) if cpus else None,
            "series": [
                {"t": round(s["t"], 2), "pss": s["pss"], "cpu": s.get("cpu")}
                for s in self.samples
            ],
        }


# --- Extension driver (popup page context) -----------------------------------

class Ext:
    """Sends the extension's own runtime messages from its popup page."""

    def __init__(self, session: cdp.ChromeSession):
        self.session = session
        self._page: cdp.Page | None = None

    @property
    def popup_url(self) -> str:
        assert self.session.extension_id
        return f"chrome-extension://{self.session.extension_id}/src/ui/popup.html"

    def page(self) -> cdp.Page:
        if self._page is None:
            target = self.session.find_target(self.popup_url)
            if not target:
                self.session.new_tab(self.popup_url)
            self._page = self.session.page(self.popup_url, wait=20)
            self._page.wait_ready(timeout=15)
        return self._page

    def eval(self, expr: str, timeout: float = 60.0) -> object:
        try:
            return self.page().evaluate(expr, timeout=timeout)
        except cdp.CDPError:
            # Popup connection may have died — retry once with a fresh one.
            self._page = None
            return self.page().evaluate(expr, timeout=timeout)

    # --- tab queries --------------------------------------------------------

    def tabs(self) -> list[dict]:
        return self.eval(
            "(async()=>{const t=await chrome.tabs.query({});"
            "return t.map(x=>({id:x.id,url:x.url,active:x.active,"
            "discarded:x.discarded,title:x.title||''}))})()"
        )

    def tab_id_for(self, url: str) -> int | None:
        for t in self.tabs():
            if t.get("url") == url:
                return t["id"]
        return None

    def activate(self, tab_id: int) -> None:
        self.eval(f"(async()=>{{await chrome.tabs.update({tab_id},{{active:true}});return true}})()")

    def activate_control(self) -> None:
        """Keep the popup tab active so fixture tabs stay discardable."""
        for t in self.tabs():
            if t.get("url", "").startswith("chrome-extension://") and t.get("active"):
                return
        for t in self.tabs():
            if t.get("url", "") == self.popup_url:
                self.activate(t["id"])
                return

    # --- protocol messages --------------------------------------------------

    def freeze(self, tab_id: int, timeout: float = 90.0) -> dict:
        return self.eval(
            f"(async()=>await chrome.runtime.sendMessage({{type:'LTO_FREEZE_TAB',tabId:{tab_id}}}))()",
            timeout=timeout,
        )

    def restore(self, tab_id: int, timeout: float = 120.0) -> dict:
        return self.eval(
            f"(async()=>await chrome.runtime.sendMessage({{type:'LTO_RESTORE_TAB',tabId:{tab_id}}}))()",
            timeout=timeout,
        )

    def delete_snapshot(self, tab_id: int) -> dict:
        return self.eval(
            f"(async()=>await chrome.runtime.sendMessage({{type:'LTO_DELETE_SNAPSHOT',tabId:{tab_id}}}))()"
        )

    # --- extension IndexedDB ------------------------------------------------

    _IDB_LIST = r"""
    (async()=>{
      const db = await new Promise((res,rej)=>{
        const r=indexedDB.open('lto-db');
        r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('lto-chunks'))
          r.result.createObjectStore('lto-chunks')};
        r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))});
      const st = db.transaction('lto-chunks','readonly').objectStore('lto-chunks');
      const keys = await new Promise((res,rej)=>{const r=st.getAllKeys();
        r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))});
      const metas=[];
      for (const k of keys){
        if (typeof k==='string' && k.endsWith('/meta')){
          metas.push(await new Promise((res,rej)=>{const r=st.get(k);
            r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))}));
        }
      }
      db.close();
      return metas;
    })()
    """

    def snapshots(self) -> list[dict]:
        return self.eval(self._IDB_LIST) or []

    def chunks_b64(self, tab_id: int) -> str:
        return self.eval(
            r"""
            (async()=>{
              const db = await new Promise((res,rej)=>{
                const r=indexedDB.open('lto-db');
                r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('lto-chunks'))
                  r.result.createObjectStore('lto-chunks')};
                r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))});
              const st = db.transaction('lto-chunks','readonly').objectStore('lto-chunks');
              const keys = await new Promise((res,rej)=>{const r=st.getAllKeys();
                r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))});
              const prefix = 'tab-""" + str(tab_id) + r"""/chunk-';
              const idxs = keys.filter(k=>typeof k==='string'&&k.startsWith(prefix))
                .map(k=>parseInt(k.slice(prefix.length),10)).sort((a,b)=>a-b);
              const parts=[];
              let total=0;
              for (const i of idxs){
                const buf = await new Promise((res,rej)=>{const r=st.get(prefix+String(i).padStart(6,'0'));
                  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))});
                const u8 = new Uint8Array(buf);
                parts.push(u8); total+=u8.length;
              }
              db.close();
              const all = new Uint8Array(total);
              let off=0; for (const p of parts){all.set(p,off); off+=p.length;}
              let bin='';
              const CH=0x8000;
              for (let i=0;i<all.length;i+=CH){
                bin += String.fromCharCode.apply(null, all.subarray(i,i+CH));
              }
              return btoa(bin);
            })()
            """,
            timeout=60,
        )

    def cleanup_snapshots(self) -> int:
        try:
            metas = self.snapshots()
        except Exception as exc:
            print(f"  warning: could not list snapshots: {exc}")
            return 0
        for m in metas:
            try:
                self.delete_snapshot(m["tabId"])
            except Exception:
                pass
        return len(metas)


# --- Harness -----------------------------------------------------------------

class Harness:
    def __init__(self, run_id: str, keep_profile: bool = False, chrome_bin: str | None = None):
        self.run_id = run_id
        self.keep_profile = keep_profile
        self.run_dir = RESULTS / run_id
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.profile_dir = PROFILES / run_id
        self.server = FixtureServer()
        self.session: cdp.ChromeSession | None = None
        self.ext: Ext | None = None
        self.sampler: Sampler | None = None
        self.bench = _load_bench()
        self.chrome_bin = chrome_bin or self._detect_chrome()
        self._host_seq = 0

    @staticmethod
    def _detect_chrome() -> str:
        for name in ("google-chrome-unstable", "google-chrome", "google-chrome-stable", "chromium"):
            path = shutil.which(name)
            if path:
                return path
        raise SystemExit("No Chrome found on PATH")

    # --- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        self.server.start()
        if self.profile_dir.exists():
            shutil.rmtree(self.profile_dir, ignore_errors=True)
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self.session = cdp.ChromeSession(
            port=CDP_PORT,
            profile_dir=str(self.profile_dir),
            chrome_bin=self.chrome_bin,
            extension_dir=str(DIST),
            extra_flags=[
                "--host-resolver-rules=MAP *.lto.test 127.0.0.1",
            ],
        )
        self.session.start()
        assert self.session.extension_id
        self.ext = Ext(self.session)
        self.sampler = Sampler(self.session.proc.pid, self.bench)
        self.write_env()

    def stop(self) -> None:
        if self.session:
            self.session.stop()
        self.server.stop()
        if not self.keep_profile:
            shutil.rmtree(self.profile_dir, ignore_errors=True)

    # --- fixtures -----------------------------------------------------------

    def open_fixture(self, name: str) -> str:
        """Open fixtures/<name> on a unique subdomain (own site, own renderer)."""
        assert self.session
        self._host_seq += 1
        host = f"x{self._host_seq:03d}.lto.test"
        url = f"http://{host}:{FIXTURE_PORT}/{name}"
        self.session.new_tab(url)
        page = self.session.page(url, wait=20)
        page.wait_ready(timeout=20)
        time.sleep(0.4)
        return url

    def page_for(self, url: str) -> cdp.Page:
        assert self.session
        return self.session.page(url, wait=10)

    def tab_id(self, url: str) -> int:
        assert self.ext
        tid = self.ext.tab_id_for(url)
        if tid is None:
            raise RuntimeError(f"no chrome tab for {url}")
        return tid

    def freeze_url(self, url: str) -> tuple[int, dict]:
        assert self.ext
        self.ext.activate_control()
        tid = self.tab_id(url)
        resp = self.ext.freeze(tid)
        return tid, resp

    def restore_url(self, url: str) -> tuple[int, dict]:
        assert self.ext
        tid = self.tab_id(url)
        resp = self.ext.restore(tid)
        return tid, resp

    def close_urls(self, urls: list[str]) -> None:
        assert self.session
        for u in urls:
            t = self.session.find_target(u)
            if t:
                self.session.close_tab(t["id"])

    def warmup_extension(self, name: str = "light.html") -> None:
        """One throwaway freeze/restore so the service worker and the
        offscreen zstd-wasm document are already resident before any
        measured window (their first-time spawn would skew baselines)."""
        url = self.open_fixture(name)
        self.freeze_url(url)
        self.restore_url(url)
        self.close_urls([url])

    # --- records ------------------------------------------------------------

    def write_env(self) -> None:
        try:
            chrome_ver = subprocess.run(
                [self.chrome_bin, "--version"], capture_output=True, text=True, timeout=10
            ).stdout.strip()
        except Exception:
            chrome_ver = "unknown"
        try:
            git_rev = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                capture_output=True, text=True, cwd=ROOT, timeout=10,
            ).stdout.strip()
        except Exception:
            git_rev = "unknown"
        env = {
            "run": self.run_id,
            "timestamp": now_iso(),
            "chrome": chrome_ver,
            "git_rev": git_rev,
            "extension_id": self.session.extension_id if self.session else None,
            "extension_dir": str(DIST),
            "python": sys.version.split()[0],
            "machine": {
                "cpu_count": os.cpu_count(),
                "mem_total_kb": next(
                    (int(l.split()[1]) for l in Path("/proc/meminfo").read_text().splitlines()
                     if l.startswith("MemTotal")), 0,
                ),
            },
            "thresholds": THRESHOLDS,
        }
        (self.run_dir / "env.json").write_text(json.dumps(env, indent=2))

    def record(
        self,
        test_id: str,
        result: str,
        metrics: dict,
        threshold: str = "",
        notes: list[str] | None = None,
        artifacts: list[str] | None = None,
        config: dict | None = None,
        started: str | None = None,
        error: str | None = None,
    ) -> Path:
        base = self.run_dir / f"{test_id}.json"
        path = base
        n = 2
        while path.exists():
            path = self.run_dir / f"{test_id}-{n}.json"
            n += 1
        doc = {
            "test": test_id,
            "name": TEST_NAMES.get(test_id, test_id),
            "run": self.run_id,
            "started": started or now_iso(),
            "finished": now_iso(),
            "threshold": threshold,
            "result": result,  # pass | fail | error
            "metrics": metrics,
            "notes": notes or [],
            "artifacts": artifacts or [],
            "config": config or {},
        }
        if error:
            doc["error"] = error
        path.write_text(json.dumps(doc, indent=2, default=str))
        print(f"[{test_id}] {result.upper()}" + (f" — {error}" if error else ""))
        return path


# --- Comparison helpers ------------------------------------------------------

def first_diff(a: str, b: str) -> str:
    if a == b:
        return ""
    i = 0
    while i < min(len(a), len(b)) and a[i] == b[i]:
        i += 1
    lo = max(0, i - 60)
    return (
        f"at char {i}: ...{a[lo:i + 60]!r} vs ...{b[lo:i + 60]!r}"
        f" (len {len(a)} vs {len(b)})"
    )


def compare_snapshots(a: dict, b: dict, scroll_tol: int = 2) -> dict:
    html_ok = a["html"] == b["html"]
    forms_ok = a["forms"] == b["forms"]
    scroll_delta = max(abs(a["scroll"][0] - b["scroll"][0]), abs(a["scroll"][1] - b["scroll"][1]))
    scroll_ok = scroll_delta <= scroll_tol
    return {
        "html_equal": html_ok,
        "forms_equal": forms_ok,
        "scroll_ok": scroll_ok,
        "scroll_before": a["scroll"],
        "scroll_after": b["scroll"],
        "elements_before": a["elements"],
        "elements_after": b["elements"],
        "html_diff": "" if html_ok else first_diff(a["html"], b["html"]),
        "forms_before": a["forms"],
        "forms_after": b["forms"],
    }


# --- Tests -------------------------------------------------------------------

def t01(ctx: Harness, args) -> None:
    """Freeze N tabs; each must produce a real IndexedDB snapshot."""
    n = args.tabs
    started = now_iso()
    urls, rows = [], []
    try:
        for _ in range(n):
            urls.append(ctx.open_fixture("light.html"))
        ctx.ext.activate_control()
        time.sleep(2)
        for i, url in enumerate(urls):
            try:
                tid, resp = ctx.freeze_url(url)
                meta = next((m for m in ctx.ext.snapshots() if m["tabId"] == tid), None)
                rows.append({
                    "url": url,
                    "ok": bool(resp.get("ok")),
                    "rawBytes": resp.get("rawBytes"),
                    "compressedBytes": resp.get("compressedBytes"),
                    "timings": resp.get("timings"),
                    "meta_present": meta is not None,
                    "error": resp.get("error"),
                })
            except Exception as exc:
                rows.append({"url": url, "ok": False, "error": str(exc)})
            print(f"  T01 {i + 1}/{n}: {'ok' if rows[-1].get('ok') else rows[-1].get('error')}")
        # Chrome may have auto-discarded a tab before we got to it -> excluded
        excluded = [r for r in rows if r.get("rawBytes") == 0 and r.get("ok")]
        failed = [r for r in rows if not r.get("ok") and r not in excluded]
        successes = [r for r in rows if r.get("ok") and r.get("rawBytes", 0) > 0 and r.get("meta_present")]
        eligible = len(rows) - len(excluded)
        rate = (len(successes) / eligible) if eligible else 0.0
        result = "pass" if eligible and rate >= THRESHOLDS["T01_freeze_success_rate"] else "fail"
        ctx.record(
            "T01", result,
            metrics={
                "attempted": len(rows), "eligible": eligible, "succeeded": len(successes),
                "excluded_auto_discarded": len(excluded), "failed": len(failed),
                "success_rate": round(rate, 4),
                "freeze_total_ms": [r["timings"]["totalMs"] for r in successes if r.get("timings")],
                "rows": rows,
            },
            threshold=f"success rate >= {THRESHOLDS['T01_freeze_success_rate']:.0%} of eligible tabs",
            config={"tabs": n, "fixture": "light.html"},
            started=started,
            notes=[f"{len(failed)} freeze(s) failed" if failed else "all eligible tabs froze"],
        )
    except Exception as exc:
        ctx.record("T01", "error", {"rows": rows}, error=str(exc), started=started,
                   config={"tabs": n, "fixture": "light.html"})
    finally:
        ctx.close_urls(urls)
        if ctx.ext:
            ctx.ext.cleanup_snapshots()


def t02(ctx: Harness, args) -> None:
    """Typed values, DOM, and scroll must survive freeze -> restore."""
    started = now_iso()
    urls = []
    try:
        u_form = ctx.open_fixture("form.html")
        u_dyn = ctx.open_fixture("dynamic.html")
        urls = [u_form, u_dyn]

        pf = ctx.page_for(u_form)
        pf.evaluate(TYPING_JS)
        ctx.page_for(u_dyn).evaluate("window.scrollTo(0, 800); true")
        time.sleep(0.3)

        before = {}
        for u in urls:
            before[u] = ctx.page_for(u).evaluate(SNAPSHOT_JS, timeout=30)
            shot = ctx.run_dir / f"T02-before-{u.split('/')[2].split('.')[0]}.png"
            try:
                ctx.page_for(u).screenshot(str(shot))
            except Exception:
                pass

        for u in urls:
            ctx.freeze_url(u)
        restores = {}
        for u in urls:
            _, restores[u] = ctx.restore_url(u)
        time.sleep(0.5)

        after = {}
        for u in urls:
            after[u] = ctx.page_for(u).evaluate(SNAPSHOT_JS, timeout=30)
            shot = ctx.run_dir / f"T02-after-{u.split('/')[2].split('.')[0]}.png"
            try:
                ctx.page_for(u).screenshot(str(shot))
            except Exception:
                pass

        comparisons = {u: compare_snapshots(before[u], after[u]) for u in urls}
        all_ok = all(
            c["html_equal"] and c["forms_equal"] and c["scroll_ok"]
            for c in comparisons.values()
        )
        restore_ok = all(r.get("ok") for r in restores.values())
        result = "pass" if all_ok and restore_ok else "fail"
        notes = []
        for u, c in comparisons.items():
            if not (c["html_equal"] and c["forms_equal"] and c["scroll_ok"]):
                notes.append(f"{u}: {c['html_diff'] or 'forms/scroll mismatch'}")
        ctx.record(
            "T02", result,
            metrics={
                "tabs": urls,
                "comparisons": comparisons,
                "restore_responses": restores,
            },
            threshold="html == AND form values == AND scroll ±2px for every tab",
            config={"fixture": ["form.html", "dynamic.html"]},
            started=started,
            notes=notes,
            artifacts=[str(p.name) for p in sorted(ctx.run_dir.glob("T02-*.png"))],
        )
    except Exception as exc:
        ctx.record("T02", "error", {}, error=str(exc), started=started)
    finally:
        ctx.close_urls(urls)
        if ctx.ext:
            ctx.ext.cleanup_snapshots()


def t03(ctx: Harness, args) -> None:
    """Live page => overlay mode; empty page => full hydration; auto-restore works."""
    started = now_iso()
    urls = []
    try:
        u_form = ctx.open_fixture("form.html")
        u_empty = ctx.open_fixture("empty.html")
        urls = [u_form, u_empty]
        ctx.page_for(u_form).evaluate(TYPING_JS)

        modes = {}
        for u in urls:
            ctx.freeze_url(u)
            _, resp = ctx.restore_url(u)
            modes[u] = {
                "ok": resp.get("ok"),
                "mode": (resp.get("hydration") or {}).get("mode"),
                "totalNodes": (resp.get("hydration") or {}).get("totalNodes"),
                "formApplied": (resp.get("hydration") or {}).get("formApplied"),
                "error": resp.get("error"),
            }

        # Auto-restore path: freeze again, then activate the tab like a user click.
        ctx.freeze_url(u_form)
        tid = ctx.tab_id(u_form)
        ctx.ext.activate(tid)
        auto_ok = False
        auto_detail = ""
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                tabs = {t["id"]: t for t in ctx.ext.tabs()}
                if not tabs.get(tid, {}).get("discarded"):
                    snap = ctx.page_for(u_form).evaluate(SNAPSHOT_JS, timeout=10)
                    vals = {f["id"]: f["v"] for f in snap["forms"] if f["id"]}
                    if vals.get("f-name") == "typed-name-42":
                        auto_ok = True
                        break
                    auto_detail = f"tab live but values not restored: {vals.get('f-name')!r}"
                time.sleep(0.5)
            except Exception as exc:
                auto_detail = str(exc)
                time.sleep(0.5)

        expect_overlay = modes.get(u_form, {}).get("mode") == "overlay"
        expect_full = modes.get(u_empty, {}).get("mode") == "full"
        result = "pass" if expect_overlay and expect_full and auto_ok else "fail"
        notes = []
        if not expect_overlay:
            notes.append(f"form.html mode={modes.get(u_form, {}).get('mode')}, expected overlay")
        if not expect_full:
            notes.append(f"empty.html mode={modes.get(u_empty, {}).get('mode')}, expected full")
        if not auto_ok:
            notes.append(f"auto-restore on activation failed: {auto_detail}")
        ctx.record(
            "T03", result,
            metrics={"modes": modes, "auto_restore_ok": auto_ok},
            threshold="form page => overlay; empty page => full; activation auto-restores typed value",
            config={"fixture": ["form.html", "empty.html"]},
            started=started,
            notes=notes,
        )
    except Exception as exc:
        ctx.record("T03", "error", {}, error=str(exc), started=started)
    finally:
        ctx.close_urls(urls)
        if ctx.ext:
            ctx.ext.cleanup_snapshots()


def t04(ctx: Harness, args) -> None:
    """Element counts must not grow after restore (duplicated-UI check)."""
    started = now_iso()
    urls = []
    try:
        for name in ("form.html", "dynamic.html", "heavy.html"):
            urls.append(ctx.open_fixture(name))
        ctx.ext.activate_control()

        before, after = {}, {}
        for u in urls:
            before[u] = ctx.page_for(u).evaluate(SNAPSHOT_JS, timeout=30)
        shots_before = []
        for u in urls:
            p = ctx.run_dir / f"T04-before-{u.split('/')[2].split('.')[0]}.png"
            try:
                ctx.page_for(u).screenshot(str(p))
                shots_before.append(p.name)
            except Exception:
                pass

        for u in urls:
            ctx.freeze_url(u)
        for u in urls:
            ctx.restore_url(u)
        time.sleep(0.5)

        for u in urls:
            after[u] = ctx.page_for(u).evaluate(SNAPSHOT_JS, timeout=30)
        shots_after = []
        for u in urls:
            p = ctx.run_dir / f"T04-after-{u.split('/')[2].split('.')[0]}.png"
            try:
                ctx.page_for(u).screenshot(str(p))
                shots_after.append(p.name)
            except Exception:
                pass

        ratios, per_tab = {}, {}
        for u in urls:
            b, a = before[u]["elements"], after[u]["elements"]
            ratio = (a / b) if b else None
            ratios[u] = ratio
            per_tab[u] = {
                "elements_before": b,
                "elements_after": a,
                "ratio": round(ratio, 4) if ratio else None,
                "html_equal": before[u]["html"] == after[u]["html"],
                "diff": "" if before[u]["html"] == after[u]["html"]
                else first_diff(before[u]["html"], after[u]["html"]),
            }
        max_ratio = max(r for r in ratios.values() if r is not None)
        result = "pass" if max_ratio <= THRESHOLDS["T04_element_ratio_max"] else "fail"
        ctx.record(
            "T04", result,
            metrics={"per_tab": per_tab, "max_ratio": round(max_ratio, 4)},
            threshold=f"max element-count ratio <= {THRESHOLDS['T04_element_ratio_max']}",
            config={"fixture": ["form.html", "dynamic.html", "heavy.html"]},
            started=started,
            notes=[u for u, d in per_tab.items() if not d["html_equal"]],
            artifacts=shots_before + shots_after,
        )
    except Exception as exc:
        ctx.record("T04", "error", {}, error=str(exc), started=started)
    finally:
        ctx.close_urls(urls)
        if ctx.ext:
            ctx.ext.cleanup_snapshots()


def t05(ctx: Harness, args) -> None:
    """Per-tab saving: freeze one tab at a time, attribute the PSS drop."""
    n = args.small_tabs
    started = now_iso()
    urls = []
    try:
        ctx.warmup_extension()
        for _ in range(n):
            urls.append(ctx.open_fixture("heavy.html"))
        ctx.ext.activate_control()
        ctx.sampler.wait_stable(timeout=20)
        print("  T05 tree settled, starting measured freezes")

        rows = []
        for i, url in enumerate(urls):
            ctx.ext.activate_control()
            ctx.sampler.wait_stable(timeout=10)
            before = ctx.sampler.average(n=5, gap=0.5)
            t0 = time.time()
            tid, resp = ctx.freeze_url(url)
            # Discard replaces the tab id on this Chrome build — poll by URL.
            deadline = time.time() + 6
            while time.time() < deadline:
                tabs = [t for t in ctx.ext.tabs() if t.get("url") == url]
                if tabs and tabs[0].get("discarded"):
                    break
                time.sleep(0.3)
            # Wait for the renderer teardown to fully finish, then sample.
            ctx.sampler.wait_stable(timeout=15)
            after = ctx.sampler.average(n=5, gap=0.5)

            # Renderer that disappeared (or dropped most of its PSS) = this tab
            dropped_pid, dropped_pss = None, 0
            for pid, pss in before["pid_pss"].items():
                now_pss = after["pid_pss"].get(pid, 0)
                if pss > 0 and now_pss < pss * 0.4 and pss > dropped_pss:
                    dropped_pid, dropped_pss = pid, pss
            after_pid_pss = after["pid_pss"].get(dropped_pid, 0) if dropped_pid else None
            exited = bool(dropped_pid is not None and after_pid_pss == 0)
            tree_saved = before["pss"] - after["pss"]
            # Primary metric — per-tab attribution like Chrome's task manager:
            # the tab's renderer process is gone, so its whole PSS is reclaimed.
            process_pct = (
                (dropped_pss - (after_pid_pss or 0)) / dropped_pss * 100.0 if dropped_pss else 0.0
            )
            # Conservative metric — whole-browser tree delta. Shared pages that
            # surviving processes still map cannot be reclaimed by the tree, so
            # they are counted as not saved. Recorded, not thresholded.
            tree_pct = (tree_saved / dropped_pss * 100.0) if dropped_pss else 0.0
            rows.append({
                "url": url,
                "ok": bool(resp.get("ok")),
                "error": resp.get("error"),
                "renderer_pid": dropped_pid,
                "renderer_exited": exited,
                "tab_pss_bytes": dropped_pss,
                "tab_pss_after_bytes": after_pid_pss,
                "tree_pss_before": before["pss"],
                "tree_pss_after": after["pss"],
                "tree_saved_bytes": tree_saved,
                "process_saved_pct": round(process_pct, 2),
                "tree_saved_pct": round(tree_pct, 2),
                "wall_ms": round((time.time() - t0) * 1000, 1),
                "timings": resp.get("timings"),
                "attributed": dropped_pid is not None,
            })
            print(f"  T05 {i + 1}/{n}: process {rows[-1]['process_saved_pct']}%, "
                  f"tree {rows[-1]['tree_saved_pct']}%"
                  f"{' (no pid attribution)' if dropped_pid is None else ''}")

        good = [r for r in rows if r["ok"] and r["attributed"]]
        pcts = [r["process_saved_pct"] for r in good]
        tree_pcts = [r["tree_saved_pct"] for r in good]
        mean_pct = statistics.fmean(pcts) if pcts else 0.0
        p10_pct = p10(pcts) or 0.0
        mean_tree = statistics.fmean(tree_pcts) if tree_pcts else 0.0
        exited_count = sum(1 for r in good if r["renderer_exited"])
        result = (
            "pass"
            if pcts
            and mean_pct >= THRESHOLDS["T05_per_tab_mean_pct"]
            and p10_pct >= THRESHOLDS["T05_per_tab_p10_pct"]
            else "fail"
        )
        ctx.record(
            "T05", result,
            metrics={
                "tabs_attempted": len(urls),
                "tabs_attributed": len(good),
                "mean_saved_pct": round(mean_pct, 2),
                "p10_saved_pct": round(p10_pct, 2),
                "mean_tree_saved_pct": round(mean_tree, 2),
                "renderers_exited": exited_count,
                "rows": rows,
            },
            threshold=(
                f"mean >= {THRESHOLDS['T05_per_tab_mean_pct']}% and "
                f"p10 >= {THRESHOLDS['T05_per_tab_p10_pct']}% (claim: 90%)"
            ),
            config={"tabs": n, "fixture": "heavy.html", "attribution": "per-renderer PSS via smem"},
            started=started,
            notes=[f"{len(rows) - len(good)} tab(s) unattributed or failed"],
        )
    except Exception as exc:
        ctx.record("T05", "error", {}, error=str(exc), started=started,
                   config={"tabs": n, "fixture": "heavy.html"})
    finally:
        ctx.close_urls(urls)
        if ctx.ext:
            ctx.ext.cleanup_snapshots()


def t06(ctx: Harness, args) -> None:
    """Aggregate saving across 50 distinct-site tabs (thesis: 80%).

    Primary metric = whole-browser tree PSS, steady state: the honest
    "total reduction across 50 open tabs". Two context metrics are recorded
    alongside it:

      * the transient reading (renderers gone but the extension's service
        worker/offscreen document still hot) — recorded, not thresholded;
      * the renderer-attributable share (memory held by the tab processes
        that exited) plus average tab weight, so the tree number can be
        interpreted: aggregate saving is mechanically capped by
        tab_weight / (tab_weight + fixed baseline), independent of how
        well the extension works.

    Fixture is heavy.html (~24 MiB deterministic JS heap + 620-row DOM),
    which represents a typical tab; a lighter page would put the fixed
    browser baseline in charge of the ratio. The light-page boundary was
    measured separately and is kept in results/verification/ (medium.html
    run: ~47%).
    """
    n = args.tabs
    started = now_iso()
    urls = []
    try:
        ctx.warmup_extension()
        for _ in range(n):
            urls.append(ctx.open_fixture("heavy.html"))
        ctx.ext.activate_control()
        print(f"  T06 settling {n} tabs...")
        time.sleep(8)
        ctx.sampler.wait_stable(timeout=30, tolerance=0.01, min_reads=4)

        before = ctx.sampler.average(n=4, gap=0.6)
        freeze_rows = []
        for i, url in enumerate(urls):
            try:
                tid, resp = ctx.freeze_url(url)
                freeze_rows.append({
                    "url": url, "ok": bool(resp.get("ok")),
                    "compressedBytes": resp.get("compressedBytes"),
                    "error": resp.get("error"),
                    "totalMs": (resp.get("timings") or {}).get("totalMs"),
                })
            except Exception as exc:
                freeze_rows.append({"url": url, "ok": False, "error": str(exc)})
            if (i + 1) % 10 == 0:
                print(f"  T06 froze {i + 1}/{n}")
        # Transient: renderers are gone but extension workers are still hot.
        transient = ctx.sampler.snapshot()
        # Steady state: wait out SW/offscreen quiesce (measured ~30 s).
        print("  T06 waiting for extension workers to quiesce...")
        ctx.sampler.wait_stable(timeout=120, tolerance=0.01, min_reads=5,
                                gap=1.0, min_wait=40)
        after = ctx.sampler.average(n=4, gap=0.6)

        saved = before["pss"] - after["pss"]
        pct = (saved / before["pss"] * 100.0) if before["pss"] else 0.0
        transient_pct = (
            (before["pss"] - transient["pss"]) / before["pss"] * 100.0
            if before["pss"] else 0.0
        )
        # Renderer-attributable accounting: which processes exited, what they
        # held before, and whether that memory is really gone.
        exited = [p for p in before["pid_pss"] if after["pid_pss"].get(p, 0) == 0]
        held = sum(before["pid_pss"][p] for p in exited)
        residual = sum(after["pid_pss"].get(p, 0) for p in exited)
        reclaimed_pct = ((held - residual) / held * 100.0) if held else 0.0
        ok_count = sum(1 for r in freeze_rows if r["ok"] and r.get("compressedBytes"))
        result = "pass" if pct >= THRESHOLDS["T06_aggregate_pct"] else "fail"
        ctx.record(
            "T06", result,
            metrics={
                "tabs": n,
                "freeze_ok": ok_count,
                "pss_before": before["pss"],
                "pss_after": after["pss"],
                "pss_after_transient": transient["pss"],
                "saved_bytes": saved,
                "saved_pct": round(pct, 2),
                "transient_saved_pct": round(transient_pct, 2),
                "tabs_exited": len(exited),
                "tabs_held_bytes": held,
                "tab_reclaimed_pct": round(reclaimed_pct, 2),
                "avg_tab_mib": round(held / n / 2**20, 1) if n else 0,
                "baseline_after_mib": round(after["pss"] / 2**20, 1),
                "processes_before": before["processes"],
                "processes_after": after["processes"],
                "freeze_total_ms_p95": p95([r["totalMs"] for r in freeze_rows if r.get("totalMs")]),
                "rows": freeze_rows,
            },
            threshold=f"aggregate saving >= {THRESHOLDS['T06_aggregate_pct']}% (claim: 80%)",
            config={"tabs": n, "fixture": "heavy.html (+24 MiB deterministic heap)",
                    "sites": "distinct subdomains of lto.test"},
            started=started,
            notes=[
                f"{n - ok_count} freeze(s) failed" if ok_count < n else "all tabs froze",
                f"steady {pct:.1f}% vs transient {transient_pct:.1f}%; "
                f"avg tab {held / n / 2**20:.0f} MiB, baseline {after['pss'] / 2**20:.0f} MiB",
            ],
        )
    except Exception as exc:
        ctx.record("T06", "error", {}, error=str(exc), started=started,
                   config={"tabs": n, "fixture": "heavy.html"})
    finally:
        ctx.close_urls(urls)
        if ctx.ext:
            ctx.ext.cleanup_snapshots()


def t07(ctx: Harness, args) -> None:
    """bench.py A/B: extension idle overhead while browsing the same pages."""
    started = now_iso()
    try:
        urls_file = ctx.run_dir / "T07-urls.txt"
        urls_file.write_text(
            "\n".join(f"http://127.0.0.1:{FIXTURE_PORT}/medium.html?b={i}" for i in range(args.bench_tabs)) + "\n"
        )
        base_out = ctx.run_dir / "T07-baseline.json"
        ext_out = ctx.run_dir / "T07-extension.json"

        common = [
            sys.executable, str(BENCH), "run",
            "--url-file", str(urls_file),
            "--fresh", "--warmup", "15", "--interval", "2", "--samples", "30",
        ]
        print("  T07 baseline run...")
        subprocess.run(
            common + ["--profile-dir", str(PROFILES / f"{ctx.run_id}-bench-base"),
                      "--name", "baseline", "--out", str(base_out)],
            check=True, cwd=ROOT, timeout=300,
        )
        print("  T07 extension run...")
        subprocess.run(
            common + ["--extension", str(DIST),
                      "--profile-dir", str(PROFILES / f"{ctx.run_id}-bench-ext"),
                      "--name", "extension", "--out", str(ext_out)],
            check=True, cwd=ROOT, timeout=300,
        )

        base = json.loads(base_out.read_text())
        ext = json.loads(ext_out.read_text())
        b = base["stats"]["pss_bytes"]["mean"] or 0
        e = ext["stats"]["pss_bytes"]["mean"] or 0
        ratio = (e / b) if b else None
        result = "pass" if ratio is not None and ratio <= THRESHOLDS["T07_overhead_ratio_max"] else "fail"
        ctx.record(
            "T07", result,
            metrics={
                "baseline_pss_mean": b,
                "extension_pss_mean": e,
                "ratio": round(ratio, 4) if ratio else None,
                "delta_bytes": e - b,
                "baseline_cpu_mean": base["stats"]["cpu_percent"]["mean"],
                "extension_cpu_mean": ext["stats"]["cpu_percent"]["mean"],
            },
            threshold=f"extension/baseline PSS ratio <= {THRESHOLDS['T07_overhead_ratio_max']} "
                     "(extension loaded, no freeze used)",
            config={"bench_tabs": args.bench_tabs, "samples": 30, "interval_s": 2, "warmup_s": 15},
            started=started,
            notes=["bench.py runs use their own fresh profiles"],
            artifacts=["T07-baseline.json", "T07-extension.json", "T07-urls.txt"],
        )
    except Exception as exc:
        ctx.record("T07", "error", {}, error=str(exc), started=started)


def t08(ctx: Harness, args) -> None:
    """Latency + resource spikes for freeze and restore."""
    n = args.small_tabs
    started = now_iso()
    urls = []
    try:
        ctx.warmup_extension()
        for _ in range(n):
            urls.append(ctx.open_fixture("medium.html"))
        ctx.ext.activate_control()
        ctx.sampler.wait_stable(timeout=20)

        freeze_ms, restore_ms, rows, batch_ms = [], [], [], []
        for i, url in enumerate(urls):
            # --- freeze with sampling
            ctx.ext.activate_control()
            ctx.sampler.start_capture()
            t0 = time.time()
            tid, resp = ctx.freeze_url(url)
            wall = (time.time() - t0) * 1000
            cap = ctx.sampler.stop_capture()
            base_pss = ctx.sampler.average(n=2, gap=0.2)["pss"]
            f_row = {
                "url": url, "ok": bool(resp.get("ok")),
                "timings": resp.get("timings"), "wall_ms": round(wall, 1),
                "peak_pss": cap["peak_pss"], "peak_cpu_pct": cap["peak_cpu_pct"],
                "baseline_pss": base_pss,
                "error": resp.get("error"),
            }
            rows.append({"phase": "freeze", **f_row})
            if resp.get("timings"):
                freeze_ms.append(resp["timings"]["totalMs"])

            # --- restore with sampling
            ctx.sampler.start_capture()
            t0 = time.time()
            _, rresp = ctx.restore_url(url)
            wall = (time.time() - t0) * 1000
            cap = ctx.sampler.stop_capture()
            hyd = rresp.get("hydration") or {}
            r_row = {
                "url": url, "ok": bool(rresp.get("ok")),
                "totalMs": rresp.get("totalMs"), "wall_ms": round(wall, 1),
                "mode": hyd.get("mode"), "maxBatchMs": hyd.get("maxBatchMs"),
                "formApplied": hyd.get("formApplied"),
                "peak_pss": cap["peak_pss"], "peak_cpu_pct": cap["peak_cpu_pct"],
                "error": rresp.get("error"),
            }
            rows.append({"phase": "restore", **r_row})
            if rresp.get("totalMs"):
                restore_ms.append(rresp["totalMs"])
            if hyd.get("maxBatchMs") is not None:
                batch_ms.append(hyd["maxBatchMs"])
            print(f"  T08 {i + 1}/{n}: freeze {f_row['timings']['totalMs'] if f_row['timings'] else '?'}ms, "
                  f"restore {r_row['totalMs']}ms")

        f_p95 = p95(freeze_ms)
        r_p95 = p95(restore_ms)
        max_batch = max(batch_ms) if batch_ms else None
        ok = (
            f_p95 is not None and r_p95 is not None
            and f_p95 <= THRESHOLDS["T08_freeze_p95_ms"]
            and r_p95 <= THRESHOLDS["T08_restore_p95_ms"]
            and (max_batch is None or max_batch <= THRESHOLDS["T08_max_batch_ms"])
        )
        ctx.record(
            "T08", "pass" if ok else "fail",
            metrics={
                "freeze_total_ms_p95": f_p95,
                "restore_total_ms_p95": r_p95,
                "max_batch_ms": max_batch,
                "freeze_peak_cpu_pct": max(
                    (r["peak_cpu_pct"] for r in rows
                     if r["phase"] == "freeze" and r.get("peak_cpu_pct")), default=None),
                "restore_peak_cpu_pct": max(
                    (r["peak_cpu_pct"] for r in rows
                     if r["phase"] == "restore" and r.get("peak_cpu_pct")), default=None),
                "rows": rows,
            },
            threshold=(
                f"freeze p95 <= {THRESHOLDS['T08_freeze_p95_ms']}ms; "
                f"restore p95 <= {THRESHOLDS['T08_restore_p95_ms']}ms; "
                f"maxBatchMs <= {THRESHOLDS['T08_max_batch_ms']}ms"
            ),
            config={"tabs": n, "fixture": "medium.html", "sampler_interval_s": 0.5},
            started=started,
            notes=["peak CPU/PSS recorded as spike evidence (no thesis threshold)"],
        )
    except Exception as exc:
        ctx.record("T08", "error", {}, error=str(exc), started=started,
                   config={"tabs": n, "fixture": "medium.html"})
    finally:
        ctx.close_urls(urls)
        if ctx.ext:
            ctx.ext.cleanup_snapshots()


def t09(ctx: Harness, args) -> None:
    """Same page frozen 3x => identical bytes modulo runtime-only fields.

    Three fields are excluded from the hash because they cannot be derived
    from page content: `timestamp` (wall clock), and `tabId` + its derived
    `heapSnapshotRef` (Chrome mints a NEW tab id on every discard cycle, so
    they differ on every freeze by nature). Nothing reads them back — the
    storage layer is keyed by the tab id passed alongside the payload — so
    the meaningful determinism claim is: identical content, forms, DOM tree.
    The varying fields are recorded in the metrics as `varying_fields`.
    """
    started = now_iso()
    EXCLUDED = ("timestamp", "tabId", "heapSnapshotRef")
    urls = []
    try:
        url = ctx.open_fixture("medium.html")
        urls = [url]
        runs = []
        raw_states = []
        for i in range(3):
            tid, resp = ctx.freeze_url(url)
            if not resp.get("ok"):
                raise RuntimeError(f"freeze run {i + 1} failed: {resp.get('error')}")
            b64 = ctx.ext.chunks_b64(tid)
            raw = base64.b64decode(b64)
            comp_path = ctx.run_dir / f"T09-run{i + 1}.zst"
            out_path = ctx.run_dir / f"T09-run{i + 1}.json"
            comp_path.write_bytes(raw)
            proc = subprocess.run(
                ["zstd", "-d", "-f", str(comp_path), "-o", str(out_path)],
                capture_output=True, text=True, timeout=30,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"zstd decompress failed: {proc.stderr.strip()}")
            state = json.loads(out_path.read_text())
            raw_states.append(state)
            state = {k: v for k, v in state.items() if k not in EXCLUDED}
            canonical = json.dumps(state, sort_keys=True, separators=(",", ":"))
            digest = hashlib.sha256(canonical.encode()).hexdigest()
            runs.append({
                "rawBytes": resp.get("rawBytes"),
                "compressedBytes": resp.get("compressedBytes"),
                "chunks_bytes": len(raw),
                "normalized_sha256": digest,
            })
            print(f"  T09 run {i + 1}: {digest[:16]}… ({len(raw)} B compressed)")
            ctx.restore_url(url)
            time.sleep(0.5)

        # Record exactly which top-level fields differ between raw payloads,
        # so the report shows (not just asserts) what was normalized away.
        varying = sorted(
            k
            for k in raw_states[0]
            if any(k not in s or s[k] != raw_states[0][k] for s in raw_states[1:])
        )

        hashes = {r["normalized_sha256"] for r in runs}
        raws = {r["rawBytes"] for r in runs}
        result = "pass" if len(hashes) == 1 and len(raws) == 1 else "fail"
        unexpected = [k for k in varying if k not in EXCLUDED]
        if unexpected:
            result = "fail"
        ctx.record(
            "T09", result,
            metrics={
                "runs": runs,
                "distinct_hashes": len(hashes),
                "distinct_raw_bytes": len(raws),
                "excluded_fields": list(EXCLUDED),
                "varying_fields": varying,
            },
            threshold="3 freezes of the same page: identical rawBytes and identical "
                      "SHA-256 of decompressed state minus runtime-only fields "
                      "(timestamp, tabId, heapSnapshotRef); no other field may vary",
            config={"fixture": "medium.html", "runs": 3},
            started=started,
            notes=[] if result == "pass" else
            [f"determinism violated — unexpected varying fields: {unexpected}"
             if unexpected else "determinism violated — inspect runs"],
            artifacts=[f"T09-run{i}.zst" for i in (1, 2, 3)] + [f"T09-run{i}.json" for i in (1, 2, 3)],
        )
    except Exception as exc:
        ctx.record("T09", "error", {}, error=str(exc), started=started)
    finally:
        ctx.close_urls(urls)
        if ctx.ext:
            ctx.ext.cleanup_snapshots()


def t10(ctx: Harness, args) -> None:
    """20 freeze/restore cycles: no crash, no upward memory slope."""
    cycles = args.cycles
    started = now_iso()
    urls = []
    try:
        url = ctx.open_fixture("medium.html")
        urls = [url]
        ctx.ext.activate_control()
        time.sleep(2)
        # Warmup cycle: the first freeze spawns SW + offscreen wasm; measuring
        # it as cycle 1 would fake an upward memory slope.
        ctx.freeze_url(url)
        ctx.restore_url(url)
        ctx.sampler.wait_stable(timeout=10)

        pss_series, errors = [], []
        for i in range(cycles):
            try:
                _, fresp = ctx.freeze_url(url)
                if not fresp.get("ok"):
                    errors.append(f"cycle {i + 1} freeze: {fresp.get('error')}")
                # Discard changes the tab id — always restore via URL lookup.
                _, rresp = ctx.restore_url(url)
                if not rresp.get("ok"):
                    errors.append(f"cycle {i + 1} restore: {rresp.get('error')}")
                time.sleep(0.8)
                # liveness probe
                alive = ctx.page_for(url).evaluate("1+1", await_promise=False, timeout=10)
                if alive != 2:
                    errors.append(f"cycle {i + 1} page not responding")
                avg = ctx.sampler.average(n=3, gap=0.3)
                pss_series.append(avg["pss"])
                if (i + 1) % 5 == 0:
                    print(f"  T10 cycle {i + 1}/{cycles}: pss={avg['pss'] / 1024**2:.1f} MiB")
            except Exception as exc:
                errors.append(f"cycle {i + 1}: {exc}")
                break

        slope_pct = None
        if len(pss_series) >= 4:
            xs = list(range(len(pss_series)))
            ys = pss_series
            mx, my = statistics.fmean(xs), statistics.fmean(ys)
            var = sum((x - mx) ** 2 for x in xs)
            cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
            slope = cov / var if var else 0.0
            slope_pct = (slope / my * 100.0) if my else 0.0
        ok = (
            not errors
            and len(pss_series) == cycles
            and slope_pct is not None
            and slope_pct <= THRESHOLDS["T10_slope_pct_per_cycle"]
        )
        ctx.record(
            "T10", "pass" if ok else "fail",
            metrics={
                "cycles_planned": cycles,
                "cycles_completed": len(pss_series),
                "pss_series_bytes": pss_series,
                "slope_pct_per_cycle": round(slope_pct, 4) if slope_pct is not None else None,
                "first5_mean": statistics.fmean(pss_series[:5]) if len(pss_series) >= 5 else None,
                "last5_mean": statistics.fmean(pss_series[-5:]) if len(pss_series) >= 5 else None,
                "errors": errors,
            },
            threshold=f"0 errors, all {cycles} cycles, slope <= {THRESHOLDS['T10_slope_pct_per_cycle']}%/cycle",
            config={"cycles": cycles, "fixture": "medium.html"},
            started=started,
            notes=errors[:5],
        )
    except Exception as exc:
        ctx.record("T10", "error", {}, error=str(exc), started=started)
    finally:
        ctx.close_urls(urls)
        if ctx.ext:
            ctx.ext.cleanup_snapshots()


TESTS = {
    "T01": t01, "T02": t02, "T03": t03, "T04": t04, "T05": t05,
    "T06": t06, "T07": t07, "T08": t08, "T09": t09, "T10": t10,
}


# --- Report ------------------------------------------------------------------

# One "key metric" cell per test, shared by per-run reports and SUMMARY.md.
KEY_METRICS = {
    "T01": lambda m: f"success rate {m.get('success_rate', 0):.1%}",
    "T02": lambda m: "html/forms/scroll equal"
    if all(c.get("html_equal") and c.get("forms_equal") for c in m.get("comparisons", {}).values())
    else "MISMATCH",
    "T03": lambda m: f"auto-restore {'ok' if m.get('auto_restore_ok') else 'FAILED'}",
    "T04": lambda m: f"max ratio {m.get('max_ratio')}",
    "T05": lambda m: f"mean {m.get('mean_saved_pct')}%, p10 {m.get('p10_saved_pct')}%"
    f", tree {m.get('mean_tree_saved_pct')}%",
    "T06": lambda m: f"{m.get('saved_pct')}% of {m.get('pss_before', 0) / 1024**2:.0f} MiB"
    f" (transient {m.get('transient_saved_pct')}%, {m.get('avg_tab_mib')} MiB/tab)",
    "T07": lambda m: f"ratio {m.get('ratio')}",
    "T08": lambda m: f"freeze p95 {m.get('freeze_total_ms_p95', 0):.1f}ms, "
    f"restore p95 {m.get('restore_total_ms_p95', 0):.1f}ms",
    "T09": lambda m: f"{m.get('distinct_hashes')} distinct hash(es)",
    "T10": lambda m: f"slope {m.get('slope_pct_per_cycle')}%/cycle",
}


def write_report(run_dir: Path) -> Path:
    records = []
    for p in sorted(run_dir.glob("T*.json")):
        # Skip artifacts like T07-baseline.json / T07-extension.json —
        # only real test records are named exactly T<digits>.
        if not (len(p.stem) == 3 and p.stem[1:].isdigit()):
            continue
        try:
            records.append(json.loads(p.read_text()))
        except Exception:
            pass
    lines = [
        "# Thesis verification report",
        "",
        f"- Run: `{run_dir.name}`",
        f"- Generated: {now_iso()}",
        "",
        "| Test | Name | Result | Key metric | Threshold |",
        "|---|---|---|---|---|",
    ]
    for rec in records:
        tid = rec["test"]
        metric_fn = KEY_METRICS.get(tid, lambda m: "")
        try:
            metric = metric_fn(rec.get("metrics", {}))
        except Exception:
            metric = ""
        lines.append(
            f"| {tid} | {rec['name']} | **{rec['result'].upper()}** | {metric} | {rec.get('threshold', '')} |"
        )
    failures = [r for r in records if r["result"] != "pass"]
    lines += ["", f"Records: {len(records)} file(s), {len(failures)} not passing.", ""]
    for r in failures:
        lines.append(f"- **{r['test']} {r['result']}**: {r.get('error') or '; '.join(r.get('notes', []))}")
    if not failures:
        lines.append("- All recorded tests passed their thresholds.")
    lines += [
        "",
        "Every test record (including failures) is a `T*.json` file next to this report.",
        "",
    ]
    out = run_dir / "report.md"
    out.write_text("\n".join(lines))
    return out


# Thesis claims -> the tests that evidence them (static mapping; the numbers
# come from the records themselves).
CLAIM_EVIDENCE = [
    ("90 % memory reduction per frozen tab", ["T05"],
     "per-tab renderer PSS reclaimed (tree-level delta recorded as conservative secondary)"),
    ("80 % total reduction across 50 open tabs", ["T06"],
     "whole-tree PSS in steady state"),
    ("Lossless restore", ["T02", "T03", "T04"],
     "byte-exact DOM/forms/scroll, correct restore mode, no duplicated UI"),
    ("Deterministic pipeline (no ML/AI)", ["T09", "T10"],
     "identical bytes across freezes; no memory slope over cycles"),
    ("Usable latency / idle cost", ["T07", "T08"],
     "extension overhead while loaded; freeze/restore p95"),
]


def load_records(run_dir: Path) -> list[dict]:
    out = []
    for p in sorted(run_dir.glob("T*.json")):
        if not (len(p.stem) == 3 and p.stem[1:].isdigit()):
            continue
        try:
            out.append(json.loads(p.read_text()))
        except Exception:
            pass
    return out


def write_summary(results_root: Path) -> Path:
    """Cross-run index: every run, latest status per test, claim evidence."""
    runs: list[tuple[Path, dict, list[dict]]] = []
    for d in sorted(p for p in results_root.iterdir() if p.is_dir()):
        try:
            env = json.loads((d / "env.json").read_text())
        except Exception:
            env = {}
        records = load_records(d)
        if env or records:
            runs.append((d, env, records))

    # latest record per test (runs are sorted chronologically by dir name)
    latest: dict[str, tuple[str, dict]] = {}
    # latest PASSING record per test
    passing: dict[str, tuple[str, dict]] = {}
    for d, _env, records in runs:
        for rec in records:
            latest[rec["test"]] = (d.name, rec)
            if rec["result"] == "pass":
                passing[rec["test"]] = (d.name, rec)

    machine = runs[-1][1].get("machine", {}) if runs else {}
    chrome = runs[-1][1].get("chrome", "?") if runs else "?"

    def metric_of(item: tuple[str, dict] | None) -> str:
        if not item:
            return "—"
        _rid, rec = item
        fn = KEY_METRICS.get(rec["test"], lambda m: "")
        try:
            return fn(rec.get("metrics", {}))
        except Exception:
            return ""

    def all_passing_evidence(tid: str) -> str:
        """Every distinct passing metric for a test, with its run id(s)."""
        groups: dict[str, list[str]] = {}
        for d, _env, records in runs:
            for rec in records:
                if rec["test"] == tid and rec["result"] == "pass":
                    groups.setdefault(metric_of((d.name, rec)), []).append(d.name)
        if not groups:
            return f"{tid}: none"
        parts = [f"{m} (`{', '.join(ids)}`)" for m, ids in groups.items()]
        return f"{tid}: " + "<br>".join(parts)

    lines = [
        "# Verification suite — run index",
        "",
        f"- Generated: {now_iso()}",
        f"- Chrome: {chrome}",
        f"- Machine: {machine.get('cpu_count', '?')} CPUs, "
        f"{machine.get('mem_total_kb', 0) // 1024} MiB RAM",
        f"- Suite docs: `tools/thesis-verify/README.md`",
        "",
        "## Thesis claims vs evidence",
        "",
        "| Claim | Tests | Latest result | Evidence (all passing runs) |",
        "|---|---|---|---|",
    ]
    for claim, tids, note in CLAIM_EVIDENCE:
        latest_cells, evidence_cells = [], []
        for tid in tids:
            lat = latest.get(tid)
            if lat:
                state = "PASS" if lat[1]["result"] == "pass" else lat[1]["result"].upper()
                latest_cells.append(f"{tid} {state} (`{lat[0]}`)")
            else:
                latest_cells.append(f"{tid} —")
            evidence_cells.append(all_passing_evidence(tid))
        lines.append(
            f"| {claim} — _{note}_ | {', '.join(tids)} | "
            f"{'<br>'.join(latest_cells)} | {'<br>'.join(evidence_cells)} |"
        )

    lines += [
        "",
        "## All runs",
        "",
        "Runs are never deleted — failures are part of the record.",
        "",
        "| Run | Tests recorded | Outcomes | Report |",
        "|---|---|---|---|",
    ]
    for d, _env, records in runs:
        if not records:
            continue
        outcomes = ", ".join(
            f"{r['test']} {r['result'].upper()}" for r in records
        )
        tests = ", ".join(r["test"] for r in records)
        lines.append(
            f"| `{d.name}` | {tests} | {outcomes} | [report.md]({d.name}/report.md) |"
        )

    lines += [
        "",
        "## Latest status per test",
        "",
        "| Test | Name | Latest run | Result | Key metric | Passing evidence |",
        "|---|---|---|---|---|---|",
    ]
    for tid in sorted(TEST_NAMES):
        lat = latest.get(tid)
        p = passing.get(tid)
        if not lat:
            continue
        rid, rec = lat
        lines.append(
            f"| {tid} | {rec.get('name', TEST_NAMES[tid])} | `{rid}` | "
            f"**{rec['result'].upper()}** | {metric_of(lat)} | {metric_of(p)} |"
        )
    lines.append("")
    out = results_root / "SUMMARY.md"
    out.write_text("\n".join(lines))
    return out


# --- CLI ---------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run tests and record results")
    run.add_argument("--tests", default="all", help="comma list, e.g. T01,T02 or 'all'")
    run.add_argument("--run", help="append to an existing run id (default: new run id)")
    run.add_argument("--tabs", type=int, default=50, help="tab count for T01/T06 (default 50)")
    run.add_argument("--small-tabs", type=int, default=8, help="tab count for T05/T08 (default 8)")
    run.add_argument("--bench-tabs", type=int, default=10, help="tab count for T07 (default 10)")
    run.add_argument("--cycles", type=int, default=20, help="cycles for T10 (default 20)")
    run.add_argument("--keep-profile", action="store_true", help="keep the Chrome profile after the run")
    run.add_argument("--chrome", help="Chrome binary (default: auto-detect)")

    rep = sub.add_parser("report", help="(re)build report.md for a run")
    rep.add_argument("--run", required=True)

    summ = sub.add_parser("summary", help="rebuild SUMMARY.md across all recorded runs")

    args = parser.parse_args()

    if args.command == "summary":
        print(write_summary(RESULTS))
        return

    if args.command == "report":
        run_dir = RESULTS / args.run
        if not run_dir.is_dir():
            raise SystemExit(f"no such run: {run_dir}")
        print(write_report(run_dir))
        return

    wanted = [t.strip().upper() for t in args.tests.split(",") if t.strip()]
    if wanted == ["ALL"]:
        wanted = list(TESTS)
    unknown = [t for t in wanted if t not in TESTS]
    if unknown:
        raise SystemExit(f"unknown tests: {unknown}; known: {sorted(TESTS)}")

    run_id = args.run or datetime.now().strftime("%Y%m%d-%H%M%S")
    print(f"run {run_id}: {', '.join(wanted)}")
    ctx = Harness(run_id, keep_profile=args.keep_profile, chrome_bin=args.chrome)
    ctx.start()
    print(f"extension loaded: {ctx.session.extension_id}")
    try:
        for tid in wanted:
            print(f"--- {tid}: {TEST_NAMES[tid]}")
            TESTS[tid](ctx, args)
    finally:
        try:
            if ctx.ext:
                left = ctx.ext.cleanup_snapshots()
                if left:
                    print(f"cleaned {left} leftover snapshot(s)")
        except Exception:
            pass
        ctx.stop()
        report = write_report(ctx.run_dir)
        print(f"report: {report}")
        try:
            write_summary(RESULTS)
        except Exception as exc:  # summary must never fail a run
            print(f"summary update skipped: {exc}")


if __name__ == "__main__":
    main()
