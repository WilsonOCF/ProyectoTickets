#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

env_path = ROOT / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

from cursor_sdk import Agent, AgentOptions, CloudAgentOptions
from cursor_bridge import close_bridge, launch_client

api_key = os.environ["CURSOR_API_KEY"]
print("API key configurada:", bool(api_key), flush=True)

client, process = launch_client(str(ROOT))
try:
    try:
        models = client.list_models(api_key=api_key)
        print("models_ok:", [m.id for m in models[:10]], flush=True)
    except Exception as e:
        print("models_fail:", type(e).__name__, str(e), flush=True)

    result = Agent.prompt(
        'Respondé SOLO este JSON: {"project":"TI","name":"ping","priority":"low","summary":"ok","description_html":"<p>ok</p>"}',
        AgentOptions(
            api_key=api_key,
            model="auto",
            tools=[],
            cloud=CloudAgentOptions(repos=[]),
        ),
        client=client,
    )
    print(
        json.dumps(
            {
                "status": result.status,
                "result": (result.result or "")[:400],
                "error": str(result.error) if result.error else None,
                "model": getattr(result.model, "id", None),
            }
        ),
        flush=True,
    )
finally:
    close_bridge(client, process)
