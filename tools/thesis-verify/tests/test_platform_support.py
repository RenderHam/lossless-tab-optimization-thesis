#!/usr/bin/env python3
"""Unit tests for tools/thesis-verify/platform_support.py.

These tests never launch a browser and never sample a real process. Both the
Linux and the Windows code paths are exercised on either operating system by
patching ``platform_support.IS_WINDOWS`` and the module-level helpers.

Run from the repository root:

    python -m unittest discover -s tools/thesis-verify/tests -v
"""

from __future__ import annotations

import ctypes
import json
import os
import signal
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
TOOL_DIR = HERE.parent
sys.path.insert(0, str(TOOL_DIR))

import platform_support as ps  # noqa: E402


class FakeProc:
    """Minimal stand-in for subprocess.Popen."""

    def __init__(self, pid: int = 4321, exit_code=None):
        self.pid = pid
        self._exit_code = exit_code
        self.waited = []
        self.killed = False

    def poll(self):
        return self._exit_code

    def wait(self, timeout=None):
        self.waited.append(timeout)
        return 0

    def kill(self):
        self.killed = True


# --- Chrome discovery --------------------------------------------------------

class FindChromeTests(unittest.TestCase):
    def test_explicit_existing_path_wins(self):
        with tempfile.NamedTemporaryFile(suffix="chrome.exe", delete=False) as fh:
            path = fh.name
        try:
            self.assertEqual(ps.find_chrome(path), path)
        finally:
            os.unlink(path)

    def test_explicit_missing_path_is_an_error(self):
        with self.assertRaises(SystemExit):
            ps.find_chrome(os.path.join(tempfile.gettempdir(), "no-such-chrome.exe"))

    def test_posix_uses_path(self):
        with mock.patch.object(ps, "IS_WINDOWS", False), \
             mock.patch.object(ps.shutil, "which", return_value="/usr/bin/google-chrome"):
            self.assertEqual(ps.find_chrome(), "/usr/bin/google-chrome")

    def test_posix_missing_chrome_is_an_error(self):
        with mock.patch.object(ps, "IS_WINDOWS", False), \
             mock.patch.object(ps.shutil, "which", return_value=None):
            with self.assertRaises(SystemExit):
                ps.find_chrome()

    def test_windows_program_files_install_location(self):
        with tempfile.TemporaryDirectory() as root:
            exe = Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe"
            exe.parent.mkdir(parents=True)
            exe.write_bytes(b"stub")
            env = {
                "PROGRAMFILES": root,
                "PROGRAMFILES(X86)": "",
                "LOCALAPPDATA": "",
            }
            with mock.patch.object(ps, "IS_WINDOWS", True), \
                 mock.patch.object(ps.shutil, "which", return_value=None), \
                 mock.patch.dict(os.environ, env):
                self.assertEqual(ps.find_chrome(), str(exe))

    def test_windows_app_paths_registry_fallback(self):
        with tempfile.NamedTemporaryFile(suffix="chrome.exe", delete=False) as fh:
            exe = fh.name

        class FakeKey:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        fake_winreg = types.ModuleType("winreg")
        fake_winreg.HKEY_CURRENT_USER = object()
        fake_winreg.HKEY_LOCAL_MACHINE = object()

        def open_key(hive, path):
            if hive is fake_winreg.HKEY_CURRENT_USER:
                raise OSError("not installed for this user")
            return FakeKey()

        fake_winreg.OpenKey = open_key
        fake_winreg.QueryValueEx = lambda key, name: (exe, 1)

        try:
            with mock.patch.object(ps, "IS_WINDOWS", True), \
                 mock.patch.object(ps.shutil, "which", return_value=None), \
                 mock.patch.object(ps, "WINDOWS_CHROME_PATHS", ()), \
                 mock.patch.dict(os.environ, {
                     "PROGRAMFILES": "",
                     "PROGRAMFILES(X86)": "",
                     "LOCALAPPDATA": "",
                 }), \
                 mock.patch.dict(sys.modules, {"winreg": fake_winreg}):
                self.assertEqual(ps.find_chrome(), exe)
        finally:
            os.unlink(exe)


class ChromeVersionTests(unittest.TestCase):
    def test_reads_version_over_cdp(self):
        fake_cdp = types.SimpleNamespace(
            _http=lambda port, path: {"Browser": "Chrome/160.0.0.0"}
        )
        session = types.SimpleNamespace(port=9222, chrome_bin="chrome")
        with mock.patch.dict(sys.modules, {"cdp": fake_cdp}):
            self.assertEqual(ps.chrome_version(session), "Chrome/160.0.0.0")

    def test_falls_back_to_the_cli(self):
        def broken_http(port, path):
            raise RuntimeError("CDP not ready")

        fake_cdp = types.SimpleNamespace(_http=broken_http)
        session = types.SimpleNamespace(port=9222, chrome_bin="chrome")
        with mock.patch.dict(sys.modules, {"cdp": fake_cdp}), \
             mock.patch.object(ps.subprocess, "run",
                               return_value=types.SimpleNamespace(stdout="Google Chrome 160\n")):
            self.assertEqual(ps.chrome_version(session), "Google Chrome 160")

    def test_unknown_when_both_mechanisms_fail(self):
        def broken_http(port, path):
            raise RuntimeError("CDP not ready")

        fake_cdp = types.SimpleNamespace(_http=broken_http)
        session = types.SimpleNamespace(port=9222, chrome_bin="chrome")
        with mock.patch.dict(sys.modules, {"cdp": fake_cdp}), \
             mock.patch.object(ps.subprocess, "run", side_effect=OSError("no binary")):
            self.assertEqual(ps.chrome_version(session), "unknown")


# --- Machine information -----------------------------------------------------

class MachineMemoryTests(unittest.TestCase):
    def test_reads_meminfo_on_posix(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as fh:
            fh.write("MemTotal:       16384000 kB\nMemFree:  1000 kB\n")
            path = Path(fh.name)
        try:
            with mock.patch.object(ps, "IS_WINDOWS", False), \
                 mock.patch.object(ps, "MEMINFO", path):
                self.assertEqual(ps.machine_memory_kb(), 16384000)
        finally:
            path.unlink()

    def test_missing_meminfo_returns_zero(self):
        with mock.patch.object(ps, "IS_WINDOWS", False), \
             mock.patch.object(ps, "MEMINFO", Path(tempfile.gettempdir()) / "nope-meminfo"):
            self.assertEqual(ps.machine_memory_kb(), 0)

    def test_windows_api_is_used_when_available(self):
        fake_windll = mock.Mock()

        def global_memory_status_ex(arg):
            # byref() keeps a reference to the original structure.
            arg._obj.ullTotalPhys = 8 * 1024**3
            return 1

        fake_windll.kernel32.GlobalMemoryStatusEx.side_effect = global_memory_status_ex
        with mock.patch.object(ps, "IS_WINDOWS", True), \
             mock.patch.object(ctypes, "windll", fake_windll, create=True):
            self.assertEqual(ps.machine_memory_kb(), 8 * 1024 * 1024)

    def test_windows_api_failure_returns_zero(self):
        fake_windll = mock.Mock()
        fake_windll.kernel32.GlobalMemoryStatusEx.return_value = 0
        with mock.patch.object(ps, "IS_WINDOWS", True), \
             mock.patch.object(ctypes, "windll", fake_windll, create=True):
            self.assertEqual(ps.machine_memory_kb(), 0)


# --- Process lifecycle -------------------------------------------------------

class PopenKwargsTests(unittest.TestCase):
    def test_posix_starts_a_new_session(self):
        with mock.patch.object(ps, "IS_WINDOWS", False):
            self.assertEqual(ps.popen_kwargs(), {"start_new_session": True})

    def test_windows_creates_a_new_process_group(self):
        with mock.patch.object(ps, "IS_WINDOWS", True), \
             mock.patch.object(ps.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200, create=True):
            self.assertEqual(ps.popen_kwargs(), {"creationflags": 0x200})


class TerminateProcessTreeTests(unittest.TestCase):
    def test_none_and_exited_processes_are_no_ops(self):
        with mock.patch.object(ps.subprocess, "run") as run:
            ps.terminate_process_tree(None)
            ps.terminate_process_tree(FakeProc(exit_code=0))
        run.assert_not_called()

    def test_windows_uses_taskkill_tree(self):
        proc = FakeProc(pid=1234)
        with mock.patch.object(ps, "IS_WINDOWS", True), \
             mock.patch.object(ps.subprocess, "run") as run:
            ps.terminate_process_tree(proc)
        run.assert_called_once()
        args = run.call_args.args[0]
        self.assertEqual(args, ["taskkill", "/PID", "1234", "/T", "/F"])
        self.assertEqual(proc.waited, [5])

    def test_windows_kills_if_taskkill_does_not_finish(self):
        proc = FakeProc(pid=1234)

        def wait(timeout=None):
            if timeout is not None:
                raise subprocess.TimeoutExpired("taskkill", timeout)
            return 0

        proc.wait = wait
        with mock.patch.object(ps, "IS_WINDOWS", True), \
             mock.patch.object(ps.subprocess, "run"):
            ps.terminate_process_tree(proc)
        self.assertTrue(proc.killed)

    def test_posix_signals_the_process_group(self):
        proc = FakeProc(pid=99)
        # getpgid/killpg are POSIX-only; create=True keeps this test runnable
        # on Windows too (the branch under test is patched, not the OS).
        with mock.patch.object(ps, "IS_WINDOWS", False), \
             mock.patch.object(ps.os, "getpgid", return_value=77, create=True), \
             mock.patch.object(ps.os, "killpg", create=True) as killpg:
            ps.terminate_process_tree(proc)
        killpg.assert_called_once()
        self.assertEqual(killpg.call_args.args[0], 77)
        self.assertEqual(killpg.call_args.args[1], signal.SIGTERM)

    def test_posix_escalates_to_sigkill(self):
        proc = FakeProc(pid=99)
        proc.wait = mock.Mock(side_effect=[
            subprocess.TimeoutExpired("chrome", 10),
            0,
        ])
        # SIGKILL is not defined on Windows; supply the POSIX value so the
        # branch can be exercised there as well.
        sigkill = getattr(signal, "SIGKILL", 9)
        with mock.patch.object(ps, "IS_WINDOWS", False), \
             mock.patch.object(signal, "SIGKILL", sigkill, create=True), \
             mock.patch.object(ps.os, "getpgid", return_value=77, create=True), \
             mock.patch.object(ps.os, "killpg", create=True) as killpg:
            ps.terminate_process_tree(proc)
        self.assertEqual(killpg.call_args_list[0].args[1], signal.SIGTERM)
        self.assertEqual(killpg.call_args_list[1].args[1], sigkill)


# --- Memory sampling ---------------------------------------------------------

class SampleMemoryTests(unittest.TestCase):
    def test_windows_uses_working_set_and_labels_it(self):
        snap = {
            10: {"rss_bytes": 1000, "cpu_seconds": 2.5},
            11: {"rss_bytes": 500, "cpu_seconds": 1.0},
        }
        bench = types.SimpleNamespace(
            windows_snapshot=lambda profile: snap,
            CLK_TCK=1,
        )
        with mock.patch.object(ps, "IS_WINDOWS", True):
            out = ps.sample_memory(1, bench, Path("/tmp/profile"))
        self.assertEqual(out["pids"], {10, 11})
        self.assertEqual(out["rss"], 1500)
        self.assertEqual(out["pss"], 1500)
        self.assertEqual(out["pid_pss"], {10: 1000, 11: 500})
        self.assertEqual(out["ticks"], {10: 2, 11: 1})
        self.assertEqual(out["metric"], ps.MEMORY_WORKING_SET)

    def test_posix_prefers_smem(self):
        bench = types.SimpleNamespace(
            process_tree=lambda pid: ({1, 2}, {1: (0, 10), 2: (0, 20)}),
            memory_for=lambda pids: (9999, 9999),
        )
        with mock.patch.object(ps, "IS_WINDOWS", False), \
             mock.patch.object(ps, "smem_table",
                               return_value={1: (1000, 900), 2: (2000, 1800)}):
            out = ps.sample_memory(1, bench)
        self.assertEqual(out["rss"], 3000)
        self.assertEqual(out["pss"], 2700)
        self.assertEqual(out["pid_pss"], {1: 900, 2: 1800})
        self.assertEqual(out["ticks"], {1: 10, 2: 20})
        self.assertEqual(out["metric"], ps.MEMORY_PSS)

    def test_posix_falls_back_to_proc(self):
        bench = types.SimpleNamespace(
            process_tree=lambda pid: ({1}, {1: (0, 10)}),
            memory_for=lambda pids: (3000, 2000),
        )
        with mock.patch.object(ps, "IS_WINDOWS", False), \
             mock.patch.object(ps, "smem_table", return_value={}):
            out = ps.sample_memory(1, bench)
        self.assertEqual(out["rss"], 3000)
        self.assertEqual(out["pss"], 2000)
        self.assertEqual(out["pid_pss"], {})


class SmemTableTests(unittest.TestCase):
    def test_parses_smem_output_and_filters_to_known_pids(self):
        output = "  PID   RSS   PSS\n    1   100    90\n    2   200   180\n    3   300   270\n"
        with mock.patch.object(ps.shutil, "which", return_value="/usr/bin/smem"), \
             mock.patch.object(ps.subprocess, "run",
                               return_value=types.SimpleNamespace(stdout=output)):
            table = ps.smem_table({1, 2, 99})
        self.assertEqual(table, {1: (100 * 1024, 90 * 1024),
                                 2: (200 * 1024, 180 * 1024)})

    def test_no_smem_or_no_pids_returns_empty(self):
        with mock.patch.object(ps.shutil, "which", return_value=None):
            self.assertEqual(ps.smem_table({1}), {})
        with mock.patch.object(ps.shutil, "which", return_value="/usr/bin/smem"), \
             mock.patch.object(ps.subprocess, "run") as run:
            self.assertEqual(ps.smem_table(set()), {})
        run.assert_not_called()


class SampledMemoryMeanTests(unittest.TestCase):
    def test_pss_is_preferred(self):
        result = {"stats": {
            "pss_bytes": {"mean": 123.0},
            "rss_bytes": {"mean": 456.0},
        }}
        self.assertEqual(ps.sampled_memory_mean(result), (123.0, ps.MEMORY_PSS))

    def test_null_pss_falls_back_to_working_set(self):
        result = {"stats": {
            "pss_bytes": {"mean": None},
            "rss_bytes": {"mean": 456.0},
        }}
        self.assertEqual(ps.sampled_memory_mean(result),
                         (456.0, ps.MEMORY_WORKING_SET))

    def test_missing_stats_are_tolerated(self):
        self.assertEqual(ps.sampled_memory_mean({}), (None, ps.MEMORY_WORKING_SET))


# --- Snapshot decompression --------------------------------------------------

class DecompressRequestTests(unittest.TestCase):
    def test_message_is_well_formed_and_safely_quoted(self):
        payload = 'ab"c\\d'
        js = ps.decompress_request_js(payload)
        self.assertTrue(js.startswith("(async()=>{"))
        self.assertTrue(js.endswith("})()"))
        self.assertIn("LTO_OFFSCREEN_DECOMPRESS", js)
        self.assertIn("resultB64", js)
        self.assertIn("payloadB64:", js)
        # json.dumps must escape the quote and backslash exactly once.
        self.assertIn(json.dumps(payload), js)
        self.assertIn("!r.ok", js)


if __name__ == "__main__":
    unittest.main()
