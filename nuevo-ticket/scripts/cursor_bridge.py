"""Lanza cursor-sdk-bridge y conecta el Client (workaround WinError 10038)."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import sys

from cursor_sdk import Client
from cursor_sdk._vendor import resolve_bridge_path


def _bridge_bin() -> str:
    override = os.environ.get("CURSOR_SDK_BRIDGE_BIN", "").strip()
    if override:
        return override
    # Prefer .exe next to the venv python (evita el .cmd en Windows).
    sibling = Path(sys.executable).resolve().parent / "cursor-sdk-bridge.exe"
    if sibling.is_file():
        return str(sibling)
    return resolve_bridge_path()


def launch_client(
    workspace: str | None = None,
    *,
    timeout: float = 30.0,
) -> tuple[Client, subprocess.Popen[str]]:
    workspace = workspace or os.getcwd()
    argv = [
        _bridge_bin(),
        "--workspace",
        workspace,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
    ]
    process = subprocess.Popen(
        argv,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    deadline = time.monotonic() + timeout
    discovery = None
    assert process.stderr is not None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            err = process.stderr.read()
            raise RuntimeError(f"Bridge salió temprano: {err}")
        line = process.stderr.readline()
        if not line:
            time.sleep(0.05)
            continue
        if "cursor-sdk-bridge ready" in line:
            payload = line.split("cursor-sdk-bridge ready", 1)[1].strip()
            discovery = json.loads(payload)
            break
    if discovery is None:
        process.terminate()
        raise TimeoutError("No llegó discovery del bridge")

    url = discovery["url"]
    token_file = discovery.get("authTokenFile")
    if token_file:
        auth_token = Path(token_file).read_text(encoding="utf-8").strip()
    else:
        auth_token = discovery["authToken"]

    client = Client.connect(url, auth_token)
    return client, process


def close_bridge(client: Client, process: subprocess.Popen[str]) -> None:
    try:
        client.close()
    except Exception:
        pass
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
