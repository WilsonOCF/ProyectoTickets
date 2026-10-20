"""
Crea un ticket en Plane usando el MCP (stdio), no HTTP directo.
Lee token/URL/slug desde %USERPROFILE%\\.cursor\\mcp.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path


def load_plane_mcp_config() -> dict:
    mcp_path = Path(os.environ["USERPROFILE"]) / ".cursor" / "mcp.json"
    data = json.loads(mcp_path.read_text(encoding="utf-8"))
    plane = data.get("mcpServers", {}).get("plane")
    if not plane:
        raise SystemExit(f"No encontre el servidor 'plane' en {mcp_path}")
    env = plane.get("env") or {}
    if not env.get("PLANE_API_KEY"):
        raise SystemExit(f"Falta PLANE_API_KEY en {mcp_path}")
    return plane


def parse_tool_payload(result) -> object:
    """Extrae JSON del resultado MCP CallToolResult."""
    if getattr(result, "isError", False):
        texts = []
        for block in result.content or []:
            texts.append(getattr(block, "text", str(block)))
        raise SystemExit("Error MCP: " + "\n".join(texts))

    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        return structured

    for block in result.content or []:
        text = getattr(block, "text", None)
        if not text:
            continue
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return None


def as_list(payload) -> list:
    if payload is None:
        return []
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        if isinstance(payload.get("results"), list):
            return payload["results"]
        # a veces el MCP envuelve otra vez
        for key in ("data", "items", "members"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return [payload]


def find_project(projects: list, needle: str):
    needle_l = needle.lower()
    for p in projects:
        if str(p.get("identifier", "")).lower() == needle_l or str(p.get("name", "")).lower() == needle_l:
            return p
    for p in projects:
        ident = str(p.get("identifier", "")).lower()
        name = str(p.get("name", "")).lower()
        if needle_l in ident or needle_l in name:
            return p
    return None


def find_member(members: list, needle: str):
    needle_l = needle.lower()

    def fields(m):
        return [
            str(m.get("display_name") or "").lower(),
            str(m.get("first_name") or "").lower(),
            str(m.get("email") or "").lower(),
        ]

    matches = [
        m
        for m in members
        if any(needle_l == f or needle_l in f for f in fields(m) if f)
    ]
    exact = [
        m
        for m in matches
        if needle_l in (str(m.get("display_name") or "").lower(), str(m.get("first_name") or "").lower(), str(m.get("email") or "").lower())
    ]
    if exact:
        matches = exact
    return matches


async def run(proyecto: str, titulo: str, asignar: str | None, simular: bool) -> None:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    plane = load_plane_mcp_config()
    command = plane.get("command") or r"C:\Users\Arnold\.local\bin\uvx.exe"
    args = plane.get("args") or ["--python", "3.12", "plane-mcp-server", "stdio"]
    env = {**os.environ, **(plane.get("env") or {})}
    # Preferir 127.0.0.1 si venia localhost
    base = env.get("PLANE_BASE_URL", "")
    if "localhost" in base:
        env["PLANE_BASE_URL"] = base.replace("localhost", "127.0.0.1")

    server = StdioServerParameters(command=command, args=args, env=env)

    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            projects_raw = parse_tool_payload(
                await session.call_tool("project", {"action": "list", "per_page": 100})
            )
            projects = as_list(projects_raw)
            project = find_project(projects, proyecto)
            if not project:
                ids = ", ".join(str(p.get("identifier")) for p in projects)
                raise SystemExit(f"No encontre el proyecto '{proyecto}'. Hay estos: {ids}")

            assignee_ids: list[str] = []
            assignee_label = "nadie"
            if asignar:
                members_raw = parse_tool_payload(
                    await session.call_tool("member", {"action": "list_workspace", "per_page": 100})
                )
                members = as_list(members_raw)
                # list_workspace a veces anida member / user
                normalized = []
                for m in members:
                    if not isinstance(m, dict):
                        continue
                    # forma plana o anidada
                    user = m.get("member") if isinstance(m.get("member"), dict) else m
                    entry = {
                        "id": user.get("id") or m.get("member_id") or m.get("id"),
                        "display_name": user.get("display_name") or "",
                        "first_name": user.get("first_name") or "",
                        "email": user.get("email") or "",
                    }
                    if entry["id"]:
                        normalized.append(entry)
                matches = find_member(normalized, asignar)
                if not matches:
                    raise SystemExit(f"No encontre al usuario '{asignar}' en el workspace.")
                if len(matches) > 1:
                    lista = ", ".join(f"{m['first_name']} <{m['email']}>" for m in matches)
                    raise SystemExit(f"Hay varias personas que coinciden con '{asignar}': {lista}. Escribe el correo.")
                assignee_ids = [str(matches[0]["id"])]
                assignee_label = f"{matches[0]['first_name']} <{matches[0]['email']}>"

            if simular:
                print(
                    f"Crearia '{titulo}' en {project.get('identifier')} ({project.get('name')}), "
                    f"asignado a {assignee_label}."
                )
                return

            args_create: dict = {
                "action": "create",
                "project_id": str(project["id"]),
                "name": titulo,
            }
            if assignee_ids:
                args_create["assignees"] = assignee_ids

            created = parse_tool_payload(await session.call_tool("workitem", args_create))
            if not isinstance(created, dict):
                raise SystemExit(f"Respuesta inesperada al crear: {created!r}")

            seq = created.get("sequence_id")
            ident = project.get("identifier")
            slug = env.get("PLANE_WORKSPACE_SLUG", "crs")
            print(f"{ident}-{seq}: {created.get('name')}")
            print(f"Asignado a {assignee_label}")
            print(f"http://127.0.0.1:3000/{slug}/browse/{ident}-{seq}/")


def main() -> None:
    parser = argparse.ArgumentParser(description="Crear ticket Plane via MCP")
    parser.add_argument("proyecto", help="Identificador o nombre del proyecto (TI, Ventas, ...)")
    parser.add_argument("titulo", help="Titulo del ticket")
    parser.add_argument("asignar", nargs="?", default=None, help="Nombre, display_name o email")
    parser.add_argument("--simular", action="store_true", help="No crea; solo muestra que hartia")
    args = parser.parse_args()
    asyncio.run(run(args.proyecto, args.titulo, args.asignar, args.simular))


if __name__ == "__main__":
    main()
