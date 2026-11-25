#!/usr/bin/env python3
"""
Cross-platform helpers for the thesis verification suite.

Linux and Windows differ in three places that matter to the harness:

1. **Launching/killing Chrome** — POSIX uses process groups + signals;
   Windows uses a process group creation flag + `taskkill /T /F`.
2. **Memory measurement** — Linux uses PSS via `smem` (falls back to
   `/proc/<pid>/smaps_rollup`); Windows has no PSS, so it uses the Chrome
   process tree's Working Set via PowerShell/CIM (`bench.windows_snapshot`).
   The metric name is recorded in every run so the numbers are not confused.
3. **Detecting Chrome and total RAM** — PATH on Linux, known install
   locations / registry on Windows; `/proc/meminfo` vs `GlobalMemoryStatusEx`.

Pure standard library. Nothing here launches a browser or samples memory
until a helper is actually called, so the module is safe to unit-test on
either operating system.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

IS_WINDOWS = os.name == "nt"

MEMINFO = Path("/proc/meminfo")

CHROME_CANDIDATES = (
    "google-chrome-unstable",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
)

# Mirrors tools/memory-bench/bench.py so both tools find the same browser.
WINDOWS_CHROME_SUFFIXES = (
    ("Google", "Chrome", "Application", "chrome.exe"),
    ("Google", "Chrome SxS", "Application", "chrome.exe"),
    ("Microsoft", "Edge", "Application", "msedge.exe"),
)
WINDOWS_CHROME_PATHS = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
)

MEMORY_PSS = "PSS"
MEMORY_WORKING_SET = "Working Set (RSS)"


# --- Chrome discovery --------------------------------------------------------

def find_chrome(explicit: str | None = None) -> str:
    """Find Chrome/Chromium. `--chrome` always wins; then PATH, then
    Windows install locations and the App Paths registry key."""
    if explicit:
        candidate = Path(explicit)
        if candidate.is_file():
            return str(candidate)
        found = shutil.which(explicit)
        if found:
            return found
        raise SystemExit(f"Chrome binary not found: {explicit}")

    for name in CHROME_CANDIDATES:
        found = shutil.which(name)
        if found:
            return found

    if IS_WINDOWS:
        roots = [
            os.environ.get("PROGRAMFILES"),
            os.environ.get("PROGRAMFILES(X86)"),
            os.environ.get("LOCALAPPDATA"),
        ]
        for root in roots:
            if not root:
                continue
            for suffix in WINDOWS_CHROME_SUFFIXES:
                candidate = Path(root).joinpath(*suffix)
                if candidate.is_file():
                    return str(candidate)
        for path in WINDOWS_CHROME_PATHS:
            if os.path.isfile(path):
                return path
        try:
            import winreg  # noqa: F401  (Windows only)

            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                try:
                    with winreg.OpenKey(
                        hive, r"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
                    ) as key:
                        value, _ = winreg.QueryValueEx(key, None)
                        if value and os.path.isfile(value):
                            return str(value)
                except OSError:
                    continue
        except ImportError:
            pass

    raise SystemExit(
        "No Chrome/Chromium found. Install Chrome or pass --chrome <path>."
    )


def chrome_version(session) -> str:
    """Read the browser version over CDP first: `chrome.exe --version` on
    Windows does not reliably print anything."""
    try:
        import cdp  # local module; verify.py already puts its dir on sys.path

        info = cdp._http(session.port, "/json/version")
        version = info.get("Browser")
        if version:
            return str(version)
    except Exception:
        pass
    try:
        out = subprocess.run(
            [session.chrome_bin, "--version"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        if out:
            return out
    except Exception:
        pass
    return "unknown"


# --- Machine information -----------------------------------------------------

def machine_memory_kb() -> int:
    """Total physical RAM in KiB, from /proc/meminfo or GlobalMemoryStatusEx."""
    if IS_WINDOWS:
        try:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return int(status.ullTotalPhys) // 1024
        except Exception:
            pass
        return 0
    try:
        return next(
            (int(line.split()[1]) for line in MEMINFO.read_text().splitlines()
             if line.startswith("MemTotal")),
            0,
        )
    except OSError:
        return 0


# --- Process lifecycle -------------------------------------------------------

def popen_kwargs() -> dict:
    """Popen options so the browser and its children can be killed as a tree."""
    if IS_WINDOWS:
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        return {"creationflags": flags} if flags else {}
    return {"start_new_session": True}


def terminate_process_tree(proc: subprocess.Popen | None) -> None:
    """Terminate a browser process *and all of its children*."""
    if proc is None or proc.poll() is not None:
        return
    if IS_WINDOWS:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        return

    import signal

    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            proc.kill()
        proc.wait(timeout=5)


# --- Memory sampling ---------------------------------------------------------

def sample_memory(root_pid: int, bench_mod, profile_dir: Path | None = None) -> dict:
    """One process-tree sample, platform-independent shape:

    ``{pids, rss, pss, pid_pss, ticks, metric}``

    On Windows ``pss`` is the sum of Working Sets (PSS does not exist there)
    and ``metric`` says so, so records cannot be misread as PSS.
    """
    if IS_WINDOWS:
        snap = bench_mod.windows_snapshot(profile_dir) if profile_dir else {}
        pids = set(snap)
        rss = sum(v["rss_bytes"] for v in snap.values())
        # CLK_TCK is 1 on Windows and windows_snapshot reports CPU seconds.
        ticks = {pid: int(v["cpu_seconds"] * bench_mod.CLK_TCK) for pid, v in snap.items()}
        return {
            "pids": pids,
            "rss": rss,
            "pss": rss,  # Working Set used as the per-process proxy
            "pid_pss": {pid: v["rss_bytes"] for pid, v in snap.items()},
            "ticks": ticks,
            "all_stats": {pid: (0, t) for pid, t in ticks.items()},
            "metric": MEMORY_WORKING_SET,
        }

    pids, all_stats = bench_mod.process_tree(root_pid)
    table = smem_table(pids)
    if table:
        rss = sum(v[0] for v in table.values())
        pss = sum(v[1] for v in table.values())
        pid_pss = {pid: v[1] for pid, v in table.items()}
    else:
        rss, pss = bench_mod.memory_for(pids)
        pid_pss = {}
    return {
        "pids": pids,
        "rss": rss,
        "pss": pss,
        "pid_pss": pid_pss,
        "ticks": {p: all_stats[p][1] for p in pids if p in all_stats},
        "all_stats": all_stats,
        "metric": MEMORY_PSS,
    }


def smem_table(pids: set[int]) -> dict[int, tuple[int, int]]:
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
    table: dict[int, tuple[int, int]] = {}
    for line in out[1:]:
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            table[int(parts[0])] = (int(parts[1]) * 1024, int(parts[2]) * 1024)
        except ValueError:
            continue
    return {p: table[p] for p in pids if p in table}


def sampled_memory_mean(result: dict) -> tuple[float | None, str]:
    """Bench JSON -> (mean bytes, metric name). Windows bench runs have
    ``pss_bytes: null``; use Working Set in that case."""
    stats = result.get("stats", {})
    pss = (stats.get("pss_bytes") or {}).get("mean")
    if pss is not None:
        return pss, MEMORY_PSS
    rss = (stats.get("rss_bytes") or {}).get("mean")
    return rss, MEMORY_WORKING_SET


# --- Snapshot decompression --------------------------------------------------

def decompress_request_js(payload_b64: str) -> str:
    """JS expression that asks the extension's own offscreen zstd worker to
    decompress a snapshot. Works on every OS: no external `zstd` binary."""
    return (
        "(async()=>{const r=await chrome.runtime.sendMessage({type:'LTO_OFFSCREEN_DECOMPRESS',"
        "payloadB64:" + json.dumps(payload_b64) + "});"
        "if(!r||!r.ok)throw new Error((r&&r.error)||'decompress failed');"
        "return r.resultB64})()"
    )
