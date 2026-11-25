#!/usr/bin/env python3
"""
System-level comparison tool for the tab-extension thesis.

Runs two identical browsing sessions — one with a plain Chrome profile, one
with the unpacked extension loaded — and samples resource usage of the whole
browser process tree:

  * memory: Linux — RSS and PSS via `smem` (when installed) or
    /proc/<pid>/smaps_rollup. PSS avoids double-counting shared libraries.
    Windows — Working Set (RSS) via PowerShell/CIM; PSS is not available.
    Only the Chrome process tree is counted — other applications are excluded.
  * CPU: process CPU-time deltas, as % of one core
  * GPU: nvidia-smi utilization and memory on Linux only. GPU sampling is
    deliberately disabled on Windows.

Pure Python 3 standard library. No pip dependencies. Requires PowerShell on
Windows.

Note on extension loading: Chrome 137+ blocks the old `--load-extension`
flag on Google Chrome builds ("--load-extension is not allowed in Google
Chrome, ignoring"). This tool therefore installs the extension through the
DevTools protocol (`Extensions.loadUnpacked`) using the tiny stdlib
WebSocket client below, with `--enable-unsafe-extension-debugging`.

Usage:
  python3 tools/memory-bench/bench.py run --name baseline --out results/baseline.json
  python3 tools/memory-bench/bench.py run --name extension --extension dist --out results/extension.json
  python3 tools/memory-bench/bench.py compare results/baseline.json results/extension.json --out comparison.md
"""

import argparse
import base64
import json
import os
import shutil
import signal
import socket
import statistics
import struct
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

IS_WINDOWS = os.name == "nt"
CLK_TCK = os.sysconf("SC_CLK_TCK") if not IS_WINDOWS else 1
CHROME_CANDIDATES = (
    "google-chrome",
    "google-chrome-stable",
    "google-chrome-unstable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
)
WINDOWS_CHROME_PATHS = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
)


# --------------------------------------------------------------------------
# /proc sampling
# --------------------------------------------------------------------------

def read_stat(pid: int):
    """Return (ppid, total_cpu_ticks) for a PID, or None if it vanished."""
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
    except (FileNotFoundError, ProcessLookupError, PermissionError, OSError):
        return None
    end = text.rfind(")")
    if end < 0:
        return None
    fields = text[end + 2:].split()
    try:
        # fields[0] = state(3), [1] = ppid(4), [11] = utime(14), [12] = stime(15)
        return int(fields[1]), int(fields[11]) + int(fields[12])
    except (IndexError, ValueError):
        return None


def process_tree(root_pid: int):
    """All live descendants of root_pid (inclusive), re-discovered each sample."""
    all_stats = {}
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            stat = read_stat(int(entry))
            if stat:
                all_stats[int(entry)] = stat
    tree = set()
    stack = [root_pid]
    while stack:
        pid = stack.pop()
        if pid in tree or pid not in all_stats:
            continue
        tree.add(pid)
        ppid = all_stats[pid][0]
        stack.extend(p for p, s in all_stats.items() if s[0] == pid)
    return tree, all_stats


def memory_for(pids):
    """Sum RSS and PSS (bytes) over the given PIDs via smaps_rollup."""
    rss = pss = 0
    for pid in pids:
        try:
            lines = Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines()
        except (FileNotFoundError, ProcessLookupError, PermissionError, OSError):
            continue
        for line in lines:
            if line.startswith("Rss:"):
                try:
                    rss += int(line.split()[1]) * 1024
                except (IndexError, ValueError):
                    pass
            elif line.startswith("Pss:"):
                try:
                    pss += int(line.split()[1]) * 1024
                except (IndexError, ValueError):
                    pass
    return rss, pss


def smem_memory_for(pids):
    """Ask smem for RSS/PSS, then keep ONLY our Chrome-tree PIDs.

    `smem -t` alone reports every process on the machine; filtering by PID here
    is what keeps other applications out of the result.
    """
    if not shutil.which("smem") or not pids:
        return None
    try:
        out = subprocess.run(
            ["smem", "-c", "pid rss pss", "-n"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout.splitlines()
    except (OSError, subprocess.SubprocessError):
        return None
    table = {}
    for line in out[1:]:
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            # smem -n reports kB; convert to bytes.
            table[int(parts[0])] = (int(parts[1]) * 1024, int(parts[2]) * 1024)
        except ValueError:
            continue
    rss = pss = 0
    matched = 0
    for pid in pids:
        if pid in table:
            r, p = table[pid]
            rss += r
            pss += p
            matched += 1
    return (rss, pss) if matched else None


def detect_memory_source(requested: str) -> str:
    if IS_WINDOWS:
        if requested in ("auto", "powershell"):
            return "powershell"
        raise SystemExit("Windows only supports --memory-source powershell/auto")
    if requested == "auto":
        return "smem" if shutil.which("smem") else "proc"
    if requested == "smem" and not shutil.which("smem"):
        raise SystemExit("smem requested but not installed")
    if requested == "powershell":
        raise SystemExit("--memory-source powershell is only available on Windows")
    return requested


def run_powershell(script: str) -> str:
    """Run a PowerShell script without quoting headaches (UTF-16 encoded)."""
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    return result.stdout


def windows_snapshot(profile: Path) -> dict[int, dict]:
    """Chrome process tree via CIM, filtered by the browser's profile path.

    Returns {pid: {"rss_bytes": int, "cpu_seconds": float}}. Other applications
    can never enter the result because roots must match our profile path.
    """
    target = str(profile).replace("'", "''")
    script = f"""
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine
$roots = $all | Where-Object {{ $_.CommandLine -like '*{target}*' }}
$queue = New-Object System.Collections.Generic.Queue[int]
foreach ($r in $roots) {{ $queue.Enqueue([int]$r.ProcessId) }}
$seen = @{{}}
while ($queue.Count -gt 0) {{
    $currentPid = $queue.Dequeue()
    if ($seen.ContainsKey($currentPid)) {{ continue }}
    $seen[$currentPid] = $true
    foreach ($p in $all) {{
        if ([int]$p.ParentProcessId -eq $currentPid) {{ $queue.Enqueue([int]$p.ProcessId) }}
    }}
}}
$procs = Get-Process -Id $seen.Keys -ErrorAction SilentlyContinue
foreach ($p in $procs) {{ "$($p.Id),$($p.WorkingSet64),$($p.CPU)" }}
"""
    try:
        out = run_powershell(script)
    except (OSError, subprocess.SubprocessError):
        return {}
    snapshot = {}
    for line in out.splitlines():
        parts = line.strip().split(",")
        if len(parts) < 3:
            continue
        try:
            snapshot[int(parts[0])] = {
                "rss_bytes": int(parts[1]),
                "cpu_seconds": float(parts[2]),
            }
        except ValueError:
            continue
    return snapshot


def gpu_sample():
    """NVIDIA GPU utilization (%) and memory (MiB); Linux only."""
    if IS_WINDOWS:
        return None
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3,
            check=True,
        ).stdout.strip().splitlines()
        if not out:
            return None
        parts = [p.strip() for p in out[0].split(",")]
        return {"util_percent": float(parts[0]), "memory_mib": float(parts[1])}
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


# --------------------------------------------------------------------------
# Run one browsing session
# --------------------------------------------------------------------------

def detect_chrome(explicit: str | None) -> str:
    if explicit:
        if not shutil.which(explicit):
            raise SystemExit(f"Chrome binary not found: {explicit}")
        return explicit
    for name in CHROME_CANDIDATES:
        if shutil.which(name):
            return shutil.which(name)
    if IS_WINDOWS:
        for path in WINDOWS_CHROME_PATHS:
            if os.path.isfile(path):
                return path
    raise SystemExit("No Chrome/Chromium binary found. Pass --chrome /path/to/browser.")


def load_urls(args) -> list[str]:
    if args.url_file:
        urls = [
            line.strip()
            for line in Path(args.url_file).read_text().splitlines()
            if line.strip() and not line.startswith("#")
        ]
    else:
        urls = args.urls
    if not urls:
        raise SystemExit("No URLs given. Use --url-file or positional URLs.")
    return urls


def summarize(values):
    """Mean and peak over non-null samples; p95 is deterministic (nearest-rank)."""
    clean = [v for v in values if v is not None]
    if not clean:
        return {"mean": None, "peak": None, "p95": None, "samples": 0}
    ordered = sorted(clean)
    p95 = ordered[max(0, -(-len(ordered) * 95 // 100) - 1)]
    return {
        "mean": statistics.fmean(clean),
        "peak": max(clean),
        "p95": p95,
        "samples": len(clean),
    }


def terminate_chrome(proc: subprocess.Popen):
    if IS_WINDOWS:
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        proc.wait(timeout=5)


# --------------------------------------------------------------------------
# Minimal stdlib WebSocket client (for CDP Extensions.loadUnpacked)
# --------------------------------------------------------------------------
# Chrome 137+ blocks --load-extension, so the extension is installed through
# the DevTools protocol instead. Only the small RFC 6455 subset needed for
# local text messages is implemented: client masking, 16/64-bit lengths,
# fragmentation, ping/pong. Plain ws:// to 127.0.0.1 only — no TLS.


class _MiniWS:
    def __init__(self, sock, leftover=b""):
        self.sock = sock
        self.buf = leftover

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("websocket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        data = b""
        while True:
            b1, b2 = self._read(2)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if masked else None
            payload = self._read(ln) if ln else b""
            if mask:
                payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
            if opcode == 0x8:
                raise ConnectionError("websocket closed by peer")
            if opcode == 0x9:  # ping -> pong
                self._send(payload, 0xA)
                continue
            if opcode == 0xA:  # pong
                continue
            data += payload
            if fin:
                return data.decode("utf-8", "replace")

    def _send(self, payload, opcode=0x1):
        if isinstance(payload, str):
            payload = payload.encode()
        mask = os.urandom(4)
        header = bytes([0x80 | opcode])
        ln = len(payload)
        if ln < 126:
            header += bytes([0x80 | ln])
        elif ln < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", ln)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", ln)
        masked = bytes(payload[i] ^ mask[i % 4] for i in range(ln))
        self.sock.sendall(header + mask + masked)

    def call(self, obj, timeout=20):
        self._send(json.dumps(obj))
        self.sock.settimeout(timeout)
        while True:
            reply = json.loads(self.recv())
            if reply.get("id") == obj.get("id"):
                return reply

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def load_extension_via_cdp(port: int, extension_dir: Path) -> str:
    """Install an unpacked extension through CDP; returns the extension id."""
    deadline = time.time() + 25
    ver = None
    while ver is None:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as r:
                ver = json.loads(r.read())
        except Exception:
            if time.time() > deadline:
                raise SystemExit("Chrome DevTools endpoint never came up; cannot load extension")
            time.sleep(0.3)
    path = urlparse(ver["webSocketDebuggerUrl"]).path
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall(
        (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
    )
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise SystemExit("websocket handshake failed: connection closed")
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    if b"101" not in head.split(b"\r\n")[0]:
        raise SystemExit(f"websocket handshake failed: {head[:200]!r}")
    ws = _MiniWS(sock, rest)
    try:
        reply = ws.call(
            {"id": 1, "method": "Extensions.loadUnpacked", "params": {"path": str(extension_dir)}}
        )
    finally:
        ws.close()
    if "error" in reply:
        raise SystemExit(f"could not load extension {extension_dir}: {reply['error']}")
    return reply["result"]["id"]


def run_case(args) -> dict:
    chrome = detect_chrome(args.chrome)
    memory_source = detect_memory_source(args.memory_source)
    urls = load_urls(args)
    profile = Path(args.profile_dir).resolve()
    if args.fresh and profile.exists():
        shutil.rmtree(profile)
    profile.mkdir(parents=True, exist_ok=True)

    cmd = [
        chrome,
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
    ]
    extension_dir = None
    if args.extension:
        extension_dir = Path(args.extension).resolve()
        if not extension_dir.is_dir():
            raise SystemExit(f"Extension directory not found: {extension_dir}")
    # Identical flags for baseline and extension runs so the comparison is
    # fair; the debugging port is only *connected* when loading an extension.
    debug_port = free_port()
    cmd += [
        f"--remote-debugging-port={debug_port}",
        "--remote-allow-origins=*",
        "--enable-unsafe-extension-debugging",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-features=MemorySaverMode,CalculateNativeWinOcclusion",
    ]
    cmd += urls

    print(f"[{args.name}] launching: {chrome}")
    if extension_dir:
        print(f"[{args.name}] extension: {extension_dir}")
    print(f"[{args.name}] warming up for {args.warmup}s with {len(urls)} tabs...")
    popen_kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if not IS_WINDOWS:
        popen_kwargs["start_new_session"] = True
    proc = subprocess.Popen(cmd, **popen_kwargs)

    samples = []
    prev_cpu = prev_time = None
    try:
        if extension_dir:
            ext_id = load_extension_via_cdp(debug_port, extension_dir)
            print(f"[{args.name}] extension loaded: {ext_id}")
        time.sleep(args.warmup)
        print(f"[{args.name}] sampling {args.samples} times every {args.interval}s...")
        for i in range(args.samples):
            now = time.time()
            if memory_source == "powershell":
                snap = windows_snapshot(profile)
                pids = set(snap)
                rss = sum(v["rss_bytes"] for v in snap.values())
                pss = None  # Windows has no PSS equivalent
                cpu_seconds = sum(v["cpu_seconds"] for v in snap.values())
            else:
                pids, all_stats = process_tree(proc.pid)
                measured = smem_memory_for(pids) if memory_source == "smem" else memory_for(pids)
                rss, pss = measured or (0, 0)
                cpu_seconds = sum(all_stats[p][1] for p in pids if p in all_stats) / CLK_TCK
            gpu = gpu_sample()
            cpu = None
            if prev_cpu is not None and now > prev_time:
                cpu = (cpu_seconds - prev_cpu) / (now - prev_time) * 100
            samples.append(
                {
                    "index": i,
                    "time": now,
                    "processes": len(pids),
                    "rss_bytes": rss,
                    "pss_bytes": pss,
                    "cpu_percent": cpu,
                    "gpu_util_percent": gpu["util_percent"] if gpu else None,
                    "gpu_memory_mib": gpu["memory_mib"] if gpu else None,
                }
            )
            prev_cpu, prev_time = cpu_seconds, now
            if i < args.samples - 1:
                time.sleep(args.interval)
    finally:
        terminate_chrome(proc)

    result = {
        "name": args.name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "chrome": chrome,
        "extension": str(extension_dir) if extension_dir else None,
        "urls": urls,
        "config": {
            "memory_source": memory_source,
            "memory_metric": "Working Set (RSS)" if memory_source == "powershell" else "PSS",
            "warmup_seconds": args.warmup,
            "sample_interval_seconds": args.interval,
            "sample_count": args.samples,
        },
        "samples": samples,
        "stats": {
            "rss_bytes": summarize([s["rss_bytes"] for s in samples]),
            "pss_bytes": summarize([s["pss_bytes"] for s in samples]),
            "cpu_percent": summarize([s["cpu_percent"] for s in samples]),
            "gpu_util_percent": summarize([s["gpu_util_percent"] for s in samples]),
            "gpu_memory_mib": summarize([s["gpu_memory_mib"] for s in samples]),
            "processes": summarize([s["processes"] for s in samples]),
        },
    }
    return result


# --------------------------------------------------------------------------
# Compare two runs
# --------------------------------------------------------------------------

METRICS = [
    ("pss_bytes_mean", "Mean memory (PSS, MiB)", "pss_bytes", "mean", 1024**2, False),
    ("pss_bytes_peak", "Peak memory (PSS, MiB)", "pss_bytes", "peak", 1024**2, False),
    ("rss_bytes_mean", "Mean memory (RSS, MiB)", "rss_bytes", "mean", 1024**2, False),
    ("cpu_percent_mean", "Mean CPU (% of one core)", "cpu_percent", "mean", 1, False),
    ("cpu_percent_peak", "Peak CPU (% of one core)", "cpu_percent", "peak", 1, False),
    ("gpu_util_mean", "Mean GPU utilization (%)", "gpu_util_percent", "mean", 1, False),
    ("gpu_memory_peak", "Peak GPU memory (MiB)", "gpu_memory_mib", "peak", 1, False),
]


def fmt(value, divisor):
    return "n/a" if value is None else f"{value / divisor:.2f}"


def plain_summary(baseline: dict, extension: dict) -> list[str]:
    source = baseline.get("config", {}).get("memory_source", "proc")
    source_note = {
        "smem": "smem, filtered to Chrome PIDs",
        "proc": "/proc smaps_rollup for the Chrome tree",
        "powershell": "PowerShell/CIM Working Set, filtered to Chrome PIDs",
    }.get(source, source)
    is_windows = source == "powershell"
    lines = [
        "## In plain words",
        "",
        "- Scope: only the Chrome process tree was counted. Other applications were excluded.",
        f"- Memory sampler: {source_note}.",
    ]
    if is_windows:
        lines.append("- Windows has no PSS equivalent; memory is Working Set (RSS).")
    lines.append("")
    for key, label, divisor in (
        (("rss_bytes" if is_windows else "pss_bytes"),
         ("Memory (Working Set, MiB)" if is_windows else "Memory (PSS, MiB)"), 1024**2),
        ("cpu_percent", "CPU (% of one core)", 1),
        ("gpu_util_percent", "GPU utilization (%)", 1),
    ):
        b = baseline["stats"][key]["mean"]
        e = extension["stats"][key]["mean"]
        if b is None or e is None:
            lines.append(f"- {label}: not available in one or both runs.")
            continue
        diff = e - b
        if abs(diff) / divisor < 0.05:
            change = "essentially unchanged"
        else:
            direction = "less" if diff < 0 else "more"
            pct = "" if not b else f" ({abs(diff / b * 100):.1f}% {'lower' if diff < 0 else 'higher'})"
            change = f"used {abs(diff) / divisor:.1f} {direction}{pct}"
        lines.append(
            f"- {label}: baseline {b / divisor:.1f}, extension {e / divisor:.1f} — {change}."
        )
    lines.append("")
    lines.append(
        "GPU sampling is disabled on Windows; use Task Manager's GPU tab if needed."
        if is_windows
        else "GPU readings come from system-wide `nvidia-smi`, so treat them as context, not browser-only cost."
    )
    lines.append("")
    return lines


def compare(baseline: dict, extension: dict, out_path: Path | None) -> str:
    lines = [
        "# Resource usage comparison",
        "",
        f"- Baseline: `{baseline['name']}` ({baseline['timestamp']})",
        f"- With extension: `{extension['name']}` ({extension['timestamp']})",
        f"- URLs: {len(baseline['urls'])} tabs",
        "",
    ] + plain_summary(baseline, extension) + [
        "## Numbers",
        "",
        "| Metric | Baseline | With extension | Delta | Delta % |",
        "|---|---:|---:|---:|---:|",
    ]
    for _, label, key, agg, divisor, _ in METRICS:
        b = baseline["stats"][key][agg]
        e = extension["stats"][key][agg]
        delta = None if b is None or e is None else e - b
        pct = None if delta is None or not b else delta / b * 100
        lines.append(
            f"| {label} | {fmt(b, divisor)} | {fmt(e, divisor)} | "
            f"{fmt(delta, divisor)} | {'n/a' if pct is None else f'{pct:+.1f}%'} |"
        )
    lines += [
        "",
        "Negative memory delta means the extension used less memory.",
        "Positive CPU/GPU delta means the extension cost more while browsing.",
        "",
    ]
    report = "\n".join(lines)
    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report)
        print(f"Wrote {out_path}")
    return report


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="launch a browser session and sample resources")
    run.add_argument("--name", default="run", help="label for this run")
    run.add_argument("--chrome", help="path to Chrome/Chromium binary (auto-detected by default)")
    run.add_argument("--extension", help="path to unpacked extension directory (e.g. dist/)")
    run.add_argument("--profile-dir", default="tools/memory-bench/profiles/run", help="Chrome user-data-dir")
    run.add_argument("--fresh", action="store_true", help="delete the profile directory before launching")
    run.add_argument("--url-file", help="file with one URL per line")
    run.add_argument("urls", nargs="*", help="URLs to open as tabs")
    run.add_argument("--warmup", type=int, default=10, help="seconds to wait before sampling")
    run.add_argument("--interval", type=float, default=1.0, help="seconds between samples")
    run.add_argument("--samples", type=int, default=60, help="number of samples")
    run.add_argument(
        "--memory-source",
        choices=("auto", "smem", "proc", "powershell"),
        default="auto",
        help="memory sampler: smem/proc on Linux, powershell on Windows; default auto",
    )
    run.add_argument("--out", required=True, help="output JSON path")

    cmp = sub.add_parser("compare", help="compare two run JSON files")
    cmp.add_argument("baseline")
    cmp.add_argument("extension")
    cmp.add_argument("--out", help="output Markdown path (prints to stdout if omitted)")

    args = parser.parse_args()
    if args.command == "run":
        if args.samples < 2:
            raise SystemExit("--samples must be at least 2 to measure CPU deltas")
        result = run_case(args)
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2))
        print(f"[{args.name}] wrote {out}")
        metric = result["config"]["memory_metric"]
        bytes_key = "rss_bytes" if metric.startswith("Working Set") else "pss_bytes"
        value = result["stats"][bytes_key]["mean"]
        print(f"[{args.name}] mean {metric}: {(value or 0) / 1024**2:.1f} MiB")
    else:
        baseline = json.loads(Path(args.baseline).read_text())
        extension = json.loads(Path(args.extension).read_text())
        report = compare(baseline, extension, Path(args.out) if args.out else None)
        if not args.out:
            print(report)


if __name__ == "__main__":
    main()
