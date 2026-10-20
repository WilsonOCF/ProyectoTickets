#!/usr/bin/env python3
"""E2E: Cursor SDK auth + Node form login + ticket create."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    value = v.strip()
    if value.startswith('"'):
        value = json.loads(value)
    elif value.startswith("'") and value.endswith("'"):
        value = value[1:-1]
    os.environ.setdefault(k.strip(), value)

BASE = os.environ.get("TEST_BASE_URL", "http://127.0.0.1:5179")
API_KEY = os.environ["CURSOR_API_KEY"]


def http_json(method: str, url: str, data=None, headers=None, jar: CookieJar | None = None):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar or CookieJar()))
    body = None
    hdrs = dict(headers or {})
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with opener.open(req, timeout=120) as res:
            raw = res.read().decode("utf-8")
            return res.status, json.loads(raw) if raw else {}, jar or CookieJar()
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return e.code, payload, jar


def check_health():
    status, data, _ = http_json("GET", f"{BASE}/api/health")
    print("1) health:", status, data.get("ok"), "llm=", data.get("llmConfigured"), data.get("llmProvider"))
    return status == 200 and data.get("ok")


def check_cursor_sdk():
    from cursor_sdk import Agent, AgentOptions, CloudAgentOptions
    from cursor_bridge import close_bridge, launch_client

    print("2) cursor sdk…", flush=True)
    client, process = launch_client(str(ROOT))
    try:
        try:
            models = client.list_models(api_key=API_KEY)
            ids = [m.id for m in models[:8]]
            print("   models:", ids)
        except Exception as e:
            print("   models FAIL:", type(e).__name__, str(e))
            return False

        model = os.environ.get("LLM_MODEL") or "grok-4.7"
        result = Agent.prompt(
            'Respondé SOLO este JSON: {"project":"TI","name":"e2e-ping","priority":"low","summary":"ok","description_html":"<p>ok</p>"}',
            AgentOptions(
                api_key=API_KEY,
                model=model,
                tools=[],
                cloud=CloudAgentOptions(repos=[]),
            ),
            client=client,
        )
        err = getattr(result, "error", None)
        print(
            "   prompt:",
            result.status,
            "model=",
            getattr(result.model, "id", None),
            "err=",
            err,
            "result=",
            (result.result or "")[:200],
        )
        return result.status == "finished" and bool(result.result)
    finally:
        close_bridge(client, process)


def check_ticket_flow():
    jar = CookieJar()
    # unauthorized
    status, data, _ = http_json("POST", f"{BASE}/api/tickets", data={"titulo": "x"})
    # multipart needs different handling — just login + form via urllib
    print("3) no-auth tickets expect 401:", status, data.get("code"))
    ok_auth_gate = status == 401

    status, data, jar = http_json(
        "POST",
        f"{BASE}/api/auth/login",
        data={
            "email": os.environ["TEST_PLANE_EMAIL"],
            "password": os.environ["TEST_PLANE_PASSWORD"],
        },
        jar=jar,
    )
    print("4) login:", status, data.get("user", {}).get("email"))
    if status != 200:
        return False

    # multipart ticket
    boundary = "----ntboundary"
    fields = {
        "tipo": "incidencia",
        "tipoLabel": "Reportar una incidencia",
        "titulo": "E2E check formulario + Cursor + MCP",
        "prioridad": "baja",
        "descripcion": "Prueba automática de que el pipeline completo funciona.",
        "modulo": "Nuevo Ticket",
        "pasos": "1. Login\n2. Enviar\n3. Ver Plane",
    }
    parts = []
    for k, v in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n"
        )
    # tiny png
    import base64

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"capturas\"; filename=\"pixel.png\"\r\n"
        f"Content-Type: image/png\r\n\r\n"
    )
    body = "".join(parts).encode("utf-8") + png + f"\r\n--{boundary}--\r\n".encode("utf-8")

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    req = urllib.request.Request(
        f"{BASE}/api/tickets",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    print("5) creating ticket (puede tardar si Cursor responde)…", flush=True)
    try:
        with opener.open(req, timeout=300) as res:
            payload = json.loads(res.read().decode("utf-8"))
            status = res.status
    except urllib.error.HTTPError as e:
        status = e.code
        payload = json.loads(e.read().decode("utf-8"))

    analysis = payload.get("analysis") or {}
    plane = payload.get("plane") or {}
    print(
        "   ticket:",
        status,
        "analysis=",
        analysis.get("source"),
        "llm_err=",
        (payload.get("ticket") or {}).get("analysis", analysis).get("llm_error")
        if isinstance((payload.get("ticket") or {}).get("analysis", analysis), dict)
        else None,
        "plane=",
        plane.get("identifier"),
        plane.get("url"),
        "err=",
        payload.get("error"),
    )
    # Also print analysis fully
    print("   analysis detail:", json.dumps(analysis, ensure_ascii=False))
    ok_ticket = status == 200 and bool(plane.get("identifier"))
    return ok_auth_gate and ok_ticket, analysis.get("source")


def main():
    results = {}
    results["health"] = check_health()
    results["cursor"] = check_cursor_sdk()
    ok_ticket, source = check_ticket_flow()
    results["ticket"] = ok_ticket
    results["analysis_source"] = source
    print("\nSUMMARY:", json.dumps(results, ensure_ascii=False))
    # success if ticket created; cursor optional but we report it
    if results["health"] and results["ticket"]:
        return 0 if results["cursor"] else 3
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
