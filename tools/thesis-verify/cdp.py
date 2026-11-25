#!/usr/bin/env python3
"""
Chrome DevTools Protocol client for the thesis verification harness.

Chrome 137+ blocks the old `--load-extension` flag in Google Chrome builds
("--load-extension is not allowed in Google Chrome, ignoring"), so the
harness loads the unpacked extension through the CDP `Extensions.loadUnpacked`
command instead. That requires launching Chrome with
`--enable-unsafe-extension-debugging`.

Uses the `websocket-client` package from tools/thesis-verify/.venv.
"""

from __future__ import annotations

import json
import subprocess
import time
import urllib.parse
import urllib.request
from typing import Any

import websocket

from platform_support import popen_kwargs, terminate_process_tree


class CDPError(Exception):
    pass


def _http(port: int, path: str, method: str = "GET") -> Any:
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


class Connection:
    """One WebSocket CDP connection. Synchronous request/response."""

    def __init__(self, ws_url: str, timeout: float = 30.0):
        self.ws_url = ws_url
        self.timeout = timeout
        self._next_id = 0
        self._ws: websocket.WebSocket | None = None

    def connect(self) -> None:
        self._ws = websocket.create_connection(self.ws_url, timeout=self.timeout)

    @property
    def ws(self) -> websocket.WebSocket:
        if self._ws is None or self._ws.connected == 0:
            self.connect()
        assert self._ws is not None
        return self._ws

    def call(self, method: str, params: dict | None = None, timeout: float | None = None) -> Any:
        """Send a command and wait for its response (events are skipped)."""
        self._next_id += 1
        msg_id = self._next_id
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        deadline = time.time() + (timeout or self.timeout)
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise CDPError(f"timeout waiting for {method}")
            self.ws.settimeout(remaining)
            try:
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                raise CDPError(f"timeout waiting for {method}") from None
            if not isinstance(raw, str):
                continue  # binary frames are not expected
            reply = json.loads(raw)
            if reply.get("id") != msg_id:
                continue  # event or unrelated reply — skip
            if "error" in reply:
                raise CDPError(f"{method}: {reply['error'].get('message')}")
            return reply.get("result", {})

    def close(self) -> None:
        try:
            if self._ws is not None:
                self._ws.close()
        except Exception:
            pass
        self._ws = None


class ChromeSession:
    """Launch Chrome, load the extension, and hand out page connections."""

    def __init__(
        self,
        port: int,
        profile_dir: str,
        chrome_bin: str,
        extension_dir: str | None = None,
        extra_flags: list[str] | None = None,
        headless_new: bool = False,
    ):
        self.port = port
        self.profile_dir = profile_dir
        self.chrome_bin = chrome_bin
        self.extension_dir = extension_dir
        self.extra_flags = extra_flags or []
        self.headless_new = headless_new
        self.proc: subprocess.Popen | None = None
        self.browser: Connection | None = None
        self.extension_id: str | None = None

    # --- lifecycle ----------------------------------------------------------

    def start(self, timeout: float = 30.0) -> None:
        cmd = [
            self.chrome_bin,
            f"--user-data-dir={self.profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            f"--remote-debugging-port={self.port}",
            "--remote-allow-origins=*",
            "--enable-unsafe-extension-debugging",
            # Keep tabs alive: no background throttling / own auto-discard.
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--disable-features=MemorySaverMode,CalculateNativeWinOcclusion",
            "--disable-component-update",
            "--no-default-browser-check",
        ]
        if self.extension_dir:
            # CDP-only loading; --load-extension is blocked on Google Chrome.
            pass
        if self.headless_new:
            cmd.append("--headless=new")
        cmd += self.extra_flags
        cmd.append("about:blank")
        self.proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **popen_kwargs(),
        )
        deadline = time.time() + timeout
        last_err: Exception | None = None
        while time.time() < deadline:
            try:
                ver = _http(self.port, "/json/version")
                self.browser = Connection(ver["webSocketDebuggerUrl"])
                self.browser.connect()
                break
            except Exception as exc:  # not up yet
                last_err = exc
                time.sleep(0.3)
        else:
            raise CDPError(f"Chrome did not start on port {self.port}: {last_err}")
        if self.extension_dir:
            self.load_extension()

    def load_extension(self) -> str:
        assert self.browser is not None and self.extension_dir is not None
        result = self.browser.call(
            "Extensions.loadUnpacked", {"path": self.extension_dir}, timeout=20
        )
        self.extension_id = result.get("id")
        if not self.extension_id:
            raise CDPError(f"Extensions.loadUnpacked returned no id: {result}")
        return self.extension_id

    def stop(self) -> None:
        if self.browser:
            self.browser.close()
        terminate_process_tree(self.proc)
        self.proc = None

    # --- targets ------------------------------------------------------------

    def targets(self) -> list[dict]:
        return _http(self.port, "/json/list")

    def find_target(self, url_prefix: str, type_: str | None = "page") -> dict | None:
        for t in self.targets():
            if t.get("url", "").startswith(url_prefix) and (type_ is None or t.get("type") == type_):
                return t
        return None

    def new_tab(self, url: str) -> dict:
        encoded = urllib.parse.quote(url, safe="")
        for attempt in range(30):
            try:
                return _http(self.port, f"/json/new?{encoded}", method="PUT")
            except Exception:
                time.sleep(0.3)
        raise CDPError(f"could not open tab: {url}")

    def close_tab(self, target_id: str) -> None:
        try:
            _http(self.port, f"/json/close/{target_id}")
        except Exception:
            pass

    def close_tabs_by_prefix(self, url_prefix: str) -> int:
        closed = 0
        for t in self.targets():
            if t.get("url", "").startswith(url_prefix) and t.get("type") == "page":
                self.close_tab(t["id"])
                closed += 1
        return closed

    def page(self, url_prefix: str, wait: float = 15.0) -> "Page":
        """Connect to the first page target whose URL starts with `url_prefix`."""
        deadline = time.time() + wait
        while True:
            target = self.find_target(url_prefix)
            if target and target.get("webSocketDebuggerUrl"):
                conn = Connection(target["webSocketDebuggerUrl"])
                conn.connect()
                return Page(conn)
            if time.time() > deadline:
                raise CDPError(f"no target for {url_prefix} within {wait}s")
            time.sleep(0.3)


class Page:
    """Evaluate / screenshot helpers on one page target."""

    def __init__(self, conn: Connection):
        self.conn = conn

    def evaluate(self, expression: str, await_promise: bool = True, timeout: float = 30.0) -> Any:
        result = self.conn.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
                "userGesture": True,
            },
            timeout=timeout,
        )
        if result.get("exceptionDetails"):
            desc = result["exceptionDetails"].get("exception", {}).get("description") or result[
                "exceptionDetails"
            ].get("text")
            raise CDPError(f"page eval failed: {desc}")
        return result.get("result", {}).get("value")

    def wait_ready(self, timeout: float = 20.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                state = self.evaluate("document.readyState", await_promise=False, timeout=5)
                if state == "complete":
                    return
            except CDPError:
                pass
            time.sleep(0.3)
        raise CDPError("page never reached readyState complete")

    def screenshot(self, path: str) -> None:
        self.conn.call("Page.enable")
        result = self.conn.call("Page.captureScreenshot", {"format": "png"})
        import base64

        with open(path, "wb") as f:
            f.write(base64.b64decode(result["data"]))

    def close(self) -> None:
        self.conn.close()
