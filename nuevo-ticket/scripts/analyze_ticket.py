#!/usr/bin/env python3
"""Analiza un ticket con el Cursor Python SDK. Lee JSON por stdin, escribe JSON por stdout."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from cursor_sdk import (
    Agent,
    AgentOptions,
    LocalAgentOptions,
    ModelParameterValue,
    ModelSelection,
)
from cursor_bridge import close_bridge, launch_client

# Plan Plus: settings fijos por modelo (si no, "Model unavailable on Plus")
PLUS_PARAMS: dict[str, list[ModelParameterValue]] = {
    "grok-4.7": [
        ModelParameterValue(id="context", value="256k"),
        ModelParameterValue(id="reasoning_effort", value="medium"),
        ModelParameterValue(id="fast", value="false"),
    ],
    "grok-4.6": [
        ModelParameterValue(id="effort", value="medium"),
        ModelParameterValue(id="fast", value="false"),
    ],
    "grok-4.5": [
        ModelParameterValue(id="effort", value="medium"),
        ModelParameterValue(id="fast", value="false"),
    ],
    "composer-2.5": [
        ModelParameterValue(id="fast", value="false"),
    ],
}


def model_selection(model_id: str) -> ModelSelection | str:
    params = PLUS_PARAMS.get(model_id)
    if params:
        return ModelSelection(id=model_id, params=params)
    return model_id


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"ok": False, "error": "stdin vacío"}))
        return 1

    payload = json.loads(raw)
    api_key = payload.get("api_key") or os.environ.get("CURSOR_API_KEY") or ""
    model = payload.get("model") or os.environ.get("LLM_MODEL") or "grok-4.7"
    if str(model).lower() == "autho":
        model = "auto"

    if not api_key:
        print(json.dumps({"ok": False, "error": "Falta CURSOR_API_KEY"}))
        return 1

    prompt = payload["prompt"]
    images = payload.get("images") or []
    cwd = payload.get("cwd") or str(ROOT)

    message: dict | str
    if images:
        message = {"text": prompt, "images": images}
    else:
        message = prompt

    client, process = launch_client(cwd)
    try:
        result = Agent.prompt(
            message,
            AgentOptions(
                api_key=api_key,
                model=model_selection(str(model)),
                tools=[],
                local=LocalAgentOptions(cwd=cwd, setting_sources=[]),
            ),
            client=client,
        )
        out = {
            "ok": result.status == "finished" and bool(result.result),
            "status": result.status,
            "result": result.result,
            "model": getattr(result.model, "id", None) or model,
            "duration_ms": getattr(result, "duration_ms", None),
            "error": None,
        }
        err = getattr(result, "error", None)
        if err is not None:
            out["error"] = getattr(err, "message", str(err))
        elif result.status != "finished":
            out["error"] = f"status={result.status}"
        print(json.dumps(out))
        return 0 if out["ok"] else 2
    finally:
        close_bridge(client, process)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc), "type": type(exc).__name__}))
        raise SystemExit(1)
