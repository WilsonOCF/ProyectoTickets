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

from cursor_sdk import (
    Agent,
    AgentOptions,
    LocalAgentOptions,
    ModelParameterValue,
    ModelSelection,
)
from cursor_bridge import close_bridge, launch_client

api_key = os.environ["CURSOR_API_KEY"]
model_id = os.environ.get("LLM_MODEL") or "grok-4.7"

# Plus exige settings fijos del variant default
PLUS_PARAMS = {
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

selection = ModelSelection(
    id=model_id,
    params=PLUS_PARAMS.get(model_id, []),
)

client, process = launch_client(str(ROOT))
try:
    with Agent.create(
        AgentOptions(
            api_key=api_key,
            model=selection,
            tools=[],
            local=LocalAgentOptions(cwd=str(ROOT), setting_sources=[]),
        ),
        client=client,
    ) as agent:
        print("agent_id", agent.agent_id, "model", selection, flush=True)
        run = agent.send("Di solo la palabra HOLA sin nada mas.")
        print("run_id", run.id, flush=True)
        for event in run.stream():
            et = getattr(event, "type", None)
            print("EVENT", et, str(event)[:350], flush=True)
        result = run.wait()
        print(
            "FINAL",
            json.dumps(
                {
                    "status": result.status,
                    "result": (result.result or "")[:500],
                    "duration_ms": getattr(result, "duration_ms", None),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
finally:
    close_bridge(client, process)
