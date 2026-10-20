"""Servidor HTTP MCP sin sesiones OAuth ni almacenamiento persistente."""

import os
from urllib.parse import urlsplit

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route


def validate_plane_url(name: str, required: bool = False) -> None:
    value = os.getenv(name, "").strip()
    if not value:
        if required:
            raise ValueError(f"Falta la variable {name}")
        return
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"{name} debe ser una URL HTTP(S) sin credenciales ni query")
    os.environ[name] = value.rstrip("/")


async def health(_request):
    return JSONResponse({"status": "ok"})


def main() -> None:
    validate_plane_url("PLANE_BASE_URL", required=True)
    validate_plane_url("PLANE_INTERNAL_BASE_URL")
    host = os.environ["HOST"].strip()
    port = int(os.environ["PORT"])
    if not host or not 1024 <= port <= 65535:
        raise ValueError("HOST no puede estar vacio y PORT debe estar entre 1024 y 65535")
    log_level = os.environ["LOG_LEVEL"].lower()
    if log_level not in {"critical", "error", "warning", "info", "debug", "trace"}:
        raise ValueError("LOG_LEVEL no valido")

    # Los modulos oficiales leen el entorno: importar despues de validarlo.
    from plane_mcp.server import get_header_mcp

    mcp_app = get_header_mcp().http_app(path="/mcp", stateless_http=True)
    app = Starlette(
        routes=[
            Route("/healthz", health),
            Mount("/http/api-key", app=mcp_app),
        ],
        lifespan=mcp_app.lifespan,
    )
    uvicorn.run(app, host=host, port=port, log_level=log_level, access_log=False)


if __name__ == "__main__":
    main()
