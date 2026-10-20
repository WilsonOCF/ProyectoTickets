#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    os.environ.setdefault(k.strip(), v.strip())

from cursor_sdk import Agent, AgentOptions, LocalAgentOptions
from cursor_bridge import close_bridge, launch_client

api_key = os.environ["CURSOR_API_KEY"]
model = os.environ.get("LLM_MODEL") or "grok-4.7"
client, process = launch_client(str(ROOT))
try:
    result = Agent.prompt(
        'Respondé SOLO este JSON: {"project":"TI","name":"local-ping","priority":"low","summary":"ok","description_html":"<p>ok</p>"}',
        AgentOptions(
            api_key=api_key,
            model=model,
            tools=[],
            local=LocalAgentOptions(cwd=str(ROOT), setting_sources=[]),
        ),
        client=client,
    )
    print(json.dumps({
        "status": result.status,
        "model": getattr(result.model, "id", None),
        "result": (result.result or "")[:500],
        "duration_ms": getattr(result, "duration_ms", None),
    }, ensure_ascii=False))
finally:
    close_bridge(client, process)
