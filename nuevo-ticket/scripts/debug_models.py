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

from cursor_bridge import close_bridge, launch_client

api_key = os.environ["CURSOR_API_KEY"]
client, process = launch_client(str(ROOT))
try:
    models = client.list_models(api_key=api_key)
    for m in models:
        print("====", m.id, "====")
        # dump dataclass-ish
        try:
            print(json.dumps(m, default=lambda o: getattr(o, "__dict__", str(o)), indent=2)[:2000])
        except Exception:
            print(repr(m)[:2000])
        print()
finally:
    close_bridge(client, process)
