@echo off
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Necesitas Node.js. https://nodejs.org
  pause
  exit /b 1
)

where docker >nul 2>&1
if errorlevel 1 (
  echo Necesitas Docker Desktop.
  pause
  exit /b 1
)

echo Levantando Floci (S3 local en :4566)...
docker compose -f docker-compose.floci.yml up -d
if errorlevel 1 (
  echo No se pudo levantar Floci. Revisa Docker Desktop.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Instalando dependencias...
  call npm install
)

echo Abriendo Nuevo Ticket...
node server.js
pause
