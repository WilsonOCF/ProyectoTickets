@echo off
setlocal
REM Levanta el MCP oficial de Plane en modo SERVER (HTTP) en el puerto 8211.
REM Requisito: la API de Plane tiene que estar arriba en http://127.0.0.1:8000

for /f "usebackq tokens=1* delims==" %%A in (`findstr /B "PLANE_API_KEY PLANE_WORKSPACE_SLUG PLANE_BASE_URL PLANE_OAUTH_PROVIDER_CLIENT_ID PLANE_OAUTH_PROVIDER_CLIENT_SECRET PLANE_OAUTH_PROVIDER_BASE_URL" "%~dp0variables.env"`) do (
  set "%%A=%%B"
)

set "PLANE_BASE_URL=http://127.0.0.1:8000"
set "PLANE_OAUTH_PROVIDER_BASE_URL=http://127.0.0.1:8211"

echo.
echo MCP server HTTP en http://127.0.0.1:8211
echo Path con API key: http://127.0.0.1:8211/http/api-key/mcp
echo Ctrl+C para parar.
echo.

"%USERPROFILE%\.local\bin\uvx.exe" --python 3.12 plane-mcp-server http
