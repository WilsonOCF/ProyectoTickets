# PROJECT_CONTEXT — GeneradorDeTicketsIntegrado
> **Producción (21 octubre 2026):** ver [AUDITORIA_DOKPLOY.md](./AUDITORIA_DOKPLOY.md) y el Compose raíz actualizado. Las instrucciones locales, puertos publicados y variables de este documento son históricas. No copiar `.env` local a producción.
> Actualizacion: proyectos dinamicos implementados. GET /api/proyectos consulta Plane con la API key del servidor (requiere sesion). El formulario carga nombres y UUIDs al abrirse; POST /api/tickets valida project_id contra el workspace. El analisis local y LLM respetan la seleccion. No se requieren variables por proyecto. Las referencias al mapeo TI/VENTAS que siguen son historicas.


**Última actualización:** 20 octubre 2026  
**Raíz del repositorio:** `C:\Users\Arnold\Desktop\GneradorDeTicketsIntegrado`  
**Documento maestro:** estado técnico y operativo del stack unificado (Plane + Floci + MCP + Nuevo Ticket).  
**Complemento operativo corto:** `CONTEXTO_DESPLIEGUE.md`  
**Histórico CSRF/local dev (Escritorio):** `plane-login-csrf-solucion.md`, `plane-ips-csrf-analisis-completo.md`

> **Seguridad:** el índice Git contiene `.env` y `.env.tmp`; ignorarlos no elimina versiones existentes. Ver la auditoría para retirar su seguimiento y rotar las credenciales antes de desplegar.

---

## 0. Mapa del repositorio

```
GneradorDeTicketsIntegrado/
├── docker-compose.yml          # Stack maestro (Dokploy + local)
├── .env                        # Variables activas (NO commitear)
├── .env.example                # Plantilla documentada
├── PROJECT_CONTEXT.md          # Este archivo
├── CONTEXTO_DESPLIEGUE.md      # Guía despliegue resumida
├── plane/                      # Código fuente Plane Community (dev local con pnpm)
├── plane-mcp-server/           # MCP HTTP custom (Python) → build imagen plane-mcp
├── nuevo-ticket/               # App "Floci-Tickets" (Node + Express) → floci-tickets
└── floci/                      # Código fuente Floci (en compose se usa imagen floci/floci:latest)
```

**Nombre del proyecto Compose:** `generador-tickets-integrado`  
**Red Docker:** `generador-tickets-integrado_tickets-net` (bridge, alias DNS `tickets-net` en el YAML)

---

## 1. Arquitectura y componentes del stack

### 1.1 Diagrama lógico (texto)

```
                    [ Navegador usuario ]
                           |
         +-----------------+------------------+
         |                                    |
   http://localhost:5179              http://localhost (80/443)
         |                                    |
   +-----v------+                      +------v------+
   | floci-     |                      | proxy       |
   | tickets    |                      | (Caddy)     |
   +-----+------+                      +------+------+
         |         tickets-net                |
         |    +-------------------------------+
         |    |       |       |       |      |
         v    v       v       v       v      v
      floci  plane-mcp  api   web  admin  space ...
              |          |
              |          +--> plane-db (Postgres)
              |          +--> plane-redis, plane-mq, plane-minio
              v
         http://api:8000 (Plane API)
```

### 1.2 Tabla de servicios Docker Compose

| Servicio Compose | Imagen / build | Rol | Puerto host | Puerto interno | Red |
| --- | --- | --- | --- | --- | --- |
| `plane-db` | `postgres:15.7-alpine` | PostgreSQL Plane | — | 5432 | tickets-net |
| `plane-redis` | `valkey/valkey:7.2.11-alpine` | Cache / sesiones Plane | — | 6379 | tickets-net |
| `plane-mq` | `rabbitmq:3.13.6-management-alpine` | Colas Celery | — | 5672 | tickets-net |
| `plane-minio` | `pgsty/silo` (MinIO-compatible) | Adjuntos nativos Plane | — | 9000 | tickets-net |
| `migrator` | `makeplane/plane-backend:stable` | Migraciones DB (one-shot) | — | — | tickets-net |
| `api` | `makeplane/plane-backend:stable` | API Django Plane | — | 8000 | tickets-net |
| `worker` | `makeplane/plane-backend:stable` | Tareas async | — | 8000 | tickets-net |
| `beat-worker` | `makeplane/plane-backend:stable` | Cron Celery | — | 8000 | tickets-net |
| `web` | `makeplane/plane-frontend:stable` | UI Plane | — | 3000/80 | tickets-net |
| `admin` | `makeplane/plane-admin:stable` | God Mode UI | — | 3000 | tickets-net |
| `space` | `makeplane/plane-space:stable` | Public spaces | — | 3000 | tickets-net |
| `live` | `makeplane/plane-live:stable` | Colaboración live | — | 3000 | tickets-net |
| `proxy` | `makeplane/plane-proxy:stable` | Reverse proxy + TLS | **80, 443** | 80, 443 | tickets-net |
| `plane-mcp` | build `./plane-mcp-server` | Servidor MCP HTTP | **8211** | 8211 | tickets-net |
| `floci` | `floci/floci:latest` | Emulador S3 (adjuntos formulario) | — | 4566 | tickets-net |
| `floci-tickets` | build `./nuevo-ticket` | Formulario Nuevo Ticket | **5179** | 5179 | tickets-net |

### 1.3 Orden de arranque (`depends_on`)

```text
plane-db, plane-redis, plane-mq  (healthchecks)
    → migrator (exit 0)
    → api (healthy)
    → worker, beat-worker, web, live, space, admin
    → proxy

api (healthy) → plane-mcp (healthy)
api + plane-mcp + floci → floci-tickets
```

### 1.4 Volúmenes persistentes (gestionados por Compose)

| Volumen lógico | Nombre Docker típico | Contenido |
| --- | --- | --- |
| `pgdata` | `generador-tickets-integrado_pgdata` | Datos PostgreSQL |
| `redisdata` | `..._redisdata` | Redis/Valkey |
| `rabbitmq_data` | `..._rabbitmq_data` | RabbitMQ |
| `uploads` | `..._uploads` | MinIO Plane |
| `floci-data` | `..._floci-data` | Objetos S3 del formulario |
| `proxy_config`, `proxy_data` | `..._proxy_*` | TLS/proxy |
| `logs_*` | `..._logs_*` | Logs backend |

**Reset total:** `docker compose down -v` borra estos volúmenes del proyecto.

### 1.5 Desarrollo local vs stack Compose

| Modo | Plane UI | API | Formulario |
| --- | --- | --- | --- |
| **Compose (actual)** | `http://localhost` vía `proxy` | `http://api:8000` interno | `http://localhost:5179` |
| **Dev antiguo** (`plane/` + `pnpm dev`) | `http://localhost:3000` Vite | `docker-compose-local` :8000 | `nuevo-ticket` :5179 |

No mezclar `localhost` y `127.0.0.1` en el modo Vite (CSRF). En Compose unificado usar siempre `localhost` en el navegador.

---

## 2. Flujo completo de datos y autenticación

### 2.1 Flujo: formulario → Issue en Plane

```text
1. Usuario abre http://localhost:5179 (static + app.js)

2. POST /api/auth/login  { email, password }
   └─ floci-tickets → lib/plane-auth.js
      └─ Server-side fetch a http://api:8000/auth/get-csrf-token/
      └─ POST http://api:8000/auth/sign-in/
      └─ GET  http://api:8000/api/users/me/
   └─ Guarda req.session.user en cookie nt_session (cookie-session)

3. Usuario completa formulario → POST /api/tickets (multipart)
   └─ requireAuth: exige req.session.user (cookie nt_session)
   └─ Sube capturas a Floci: http://floci:4566 bucket tickets
   └─ analyzeTicket() → Cursor Python SDK (opcional) o plantilla local
   └─ createWorkItemViaMcp() → http://plane-mcp:8211/http/api-key/mcp
      Headers: Authorization: Bearer <PLANE_MCP_API_KEY>
               x-workspace-slug: wilsonws
   └─ attachFilesToWorkItem() → Plane API v1 con X-Api-Key
   └─ Backup JSON/MD/HTML en Floci (prefix por ticket)
   └─ Respuesta JSON con plane.identifier y plane.url
```

### 2.2 Dos capas de autenticación (no confundir)

| Capa | Quién | Cómo | Para qué |
| --- | --- | --- | --- |
| **Sesión del formulario** | Usuario humano | Email + password Plane → cookie `nt_session` | Gate anti-spam: solo usuarios Plane pueden enviar tickets |
| **API Key Plane** | Servicio `floci-tickets` | `PLANE_MCP_API_KEY` en servidor | MCP (crear work item) y attachments API (`X-Api-Key`) |

El contenedor **`plane-mcp` no almacena** la API key en variables de entorno: el cliente (`floci-tickets`) la envía en cada petición MCP.

### 2.3 Headers HTTP usados

**Login Plane (server → api):**

- `X-CSRFToken` + cookie `csrftoken`
- `Content-Type: application/x-www-form-urlencoded`
- `Origin` / `Referer`: `PLANE_API_URL` (`http://api:8000`)

**MCP (`lib/plane-mcp.js`):**

```http
Authorization: Bearer plane_api_REDACTED_ROTATE_BEFORE_DEPLOY
x-workspace-slug: wilsonws
Content-Type: application/json
Accept: application/json, text/event-stream
```

**Adjuntos Plane (`lib/plane-attachments.js`):**

```http
X-Api-Key: plane_api_REDACTED_ROTATE_BEFORE_DEPLOY
```

Ruta: `POST /api/v1/workspaces/{slug}/projects/{projectId}/work-items/{id}/attachments/`

### 2.4 Sesión del formulario (fix crítico aplicado)

Con `NODE_ENV=production`, **no** usar cookie `Secure` en HTTP local.

| Variable | Valor local actual | Efecto |
| --- | --- | --- |
| `SESSION_COOKIE_SECURE` | `false` | Cookie `nt_session` persiste en `http://localhost:5179` |
| `TICKETS_PUBLIC_URL` | `http://localhost:5179` | Si fuera `https://`, se activaría Secure por defecto |

Sin esto, el login “funcionaba” en UI pero el POST `/api/tickets` devolvía **401** y la app volvía al login.

### 2.5 Workspace activo

- **Slug en BD:** `wilsonws` (minúsculas; Plane normaliza slugs)
- **Nombre display:** wilsonWS
- **UUID workspace:** `ebfb7dba-94fc-411a-933b-996757fa9a03`

Proyectos de tickets del formulario en este workspace:

| Tipo formulario | Identifier | UUID proyecto |
| --- | --- | --- |
| Incidencia / mejora | TI | `6967d436-c3f5-4dcd-bb02-83f4e1533563` |
| Problema cliente | VENTAS | `5f008be7-fe7b-4414-8989-c17bdfc7518a` |

Mapeo en código: `nuevo-ticket/lib/config.js` → `PROJECTS.TI` / `PROJECTS.VENTAS`.

---

## 3. Configuración `.env` en la raíz

### 3.1 Plane / proxy

| Variable | Valor actual (local) | Propósito |
| --- | --- | --- |
| `APP_DOMAIN` | `localhost` | Dominio para proxy Plane |
| `WEB_URL` | `http://localhost` | URL pública API redirects |
| `CORS_ALLOWED_ORIGINS` | `http://localhost,http://localhost:5179` | CSRF/CORS Django |
| `APP_RELEASE` | `stable` | Tag imágenes `makeplane/*` |
| `SECRET_KEY` | (ver `.env`) | Django secret |
| `LIVE_SERVER_SECRET_KEY` | `secret-key` | Live server (cambiar en prod) |
| `DATABASE_URL` | `postgresql://plane:plane@plane-db:5432/plane` | API/workers |
| `USE_MINIO` | `1` | Storage Plane en MinIO interno |
| `AWS_S3_ENDPOINT_URL` | `http://plane-minio:9000` | MinIO interno |

### 3.2 plane-mcp

| Variable | Valor | Propósito |
| --- | --- | --- |
| `PLANE_BASE_URL` | `http://api:8000` | URL canónica hacia Plane |
| `PLANE_INTERNAL_BASE_URL` | `http://api:8000` | Llamadas container→container |
| `MCP_HOST_PORT` | `8211` | Puerto publicado |

### 3.3 floci-tickets (Nuevo Ticket)

| Variable | Valor actual | Propósito |
| --- | --- | --- |
| `PLANE_API_URL` | `http://api:8000` | Login server-side |
| `PLANE_WEB_URL` | `http://localhost` | Enlaces `browse/TI-xxx` al usuario |
| `PLANE_WORKSPACE_SLUG` | `wilsonws` | MCP + API paths |
| `PLANE_MCP_URL` | `http://plane-mcp:8211/http/api-key/mcp` | Endpoint MCP |
| `PLANE_MCP_API_KEY` | `plane_api_REDACTED_ROTATE_BEFORE_DEPLOY` | Token Wilson (MCP + attachments) |
| `SESSION_SECRET` | (≥32 chars) | Firma cookie sesión |
| `SESSION_COOKIE_SECURE` | `false` | HTTP local |
| `TICKETS_PUBLIC_URL` | `http://localhost:5179` | Detección HTTPS cookies |
| `FLOCI_BUCKET` | `tickets` | Bucket S3 emulado |
| `CURSOR_API_KEY` | vacío | LLM opcional |
| `LLM_MODEL` | `composer-2.5` | Modelo si hay key |

Variables de referencia (otros workspaces, **no** usadas por el formulario hoy):


### 3.4 Hoja de ruta: proyectos dinámicos

**Estado actual:** IDs fijos en `.env`; el front solo conoce TI y VENTAS.

**Pendiente (diseño):**

- Endpoint `GET /api/proyectos` en `floci-tickets` que consulte Plane API (`/api/v1/workspaces/{slug}/projects/`) con `X-Api-Key`
- Poblar selectores del formulario sin redeploy
- Mantener reglas de negocio: `incidencia/mejora → TI`, `cliente → VENTAS` o mapeo configurable

---

## 4. Base de datos e inventario actual (PostgreSQL)

**Contenedor:** `generador-tickets-integrado-plane-db-1`  
**DB / user / pass:** `plane` / `plane` / `plane`

### 4.1 Workspaces (6)

| name | slug | id |
| --- | --- | --- |
| milanesaWS | milanesaws | a66c4e46-9d5e-4164-8d0b-9abfd39cf8a8 |
| mathiasWS | mathiasws | 9ba055c5-d454-4c8a-86a5-f0f17469e1ab |
| arnoldWS | arnoldws | 89edba38-9ab4-4f89-93d3-00ce37cd4391 |
| eduWS | eduws | 6479738d-31c9-4dff-ad9f-5c5b3b0e65c7 |
| brayanWS | brayanws | 81fdb717-edc8-411b-9e33-cc73f00d737c |
| **wilsonWS** | **wilsonws** | ebfb7dba-94fc-411a-933b-996757fa9a03 |

### 4.2 Usuarios humanos (6, sin bots)

| email | first_name | last_name |
| --- | --- | --- |
| wilson.carrasco@gmail.com | Wilson | Carrasco |
| arnold@gmail.com | arnold | |
| brayan@gmail.com | brayan | |
| edu@gmail.com | edu | |
| mathiasia@gmail.com | mathias | |
| milanesa@gmail.com | milanesa | |

(Existen además usuarios `bot_user_*@localhost` por workspace — ignorar en operaciones humanas.)

### 4.3 Proyectos (8)

| identifier | name | workspace_slug | id |
| --- | --- | --- | --- |
| TI | TI | wilsonws | 6967d436-c3f5-4dcd-bb02-83f4e1533563 |
| VENTAS | VENTAS | wilsonws | 5f008be7-fe7b-4414-8989-c17bdfc7518a |
| WILSO | wilsonWS | wilsonws | 1739b1d5-98ea-4d26-9f21-67dbc3a46f80 |
| ARNOL | arnoldWS | arnoldws | 12cbf9e9-c33a-430c-84fd-f7017b6ba048 |
| BRAYA | brayanWS | brayanws | 72bd0de9-aa31-4517-bd88-b6ac5e2fc7fb |
| EDUWS | eduWS | eduws | 05ff127a-c1f5-49b8-b2ae-23437a783957 |
| MATHI | mathiasWS | mathiasws | f8c6fea6-ef6d-42a5-8ea8-b6eff4fa1d60 |
| MILAN | milanesaWS | milanesaws | 2ddb6b1e-bfb0-47d1-9dc5-7cbfff5b4a2d |

### 4.4 Comandos `psql` (copiar/pegar)

```bat
cd C:\Users\Arnold\Desktop\GneradorDeTicketsIntegrado

docker compose exec -T -e PGPASSWORD=plane plane-db psql -U plane -d plane -c "SELECT id, name, slug FROM workspaces;"

docker compose exec -T -e PGPASSWORD=plane plane-db psql -U plane -d plane -c "SELECT id, email, first_name, last_name FROM users WHERE email NOT LIKE 'bot_user_%' ORDER BY email;"

docker compose exec -T -e PGPASSWORD=plane plane-db psql -U plane -d plane -c "SELECT p.id, p.identifier, p.name, w.slug FROM projects p JOIN workspaces w ON p.workspace_id = w.id ORDER BY w.slug, p.identifier;"
```

### 4.5 Backup y restauración

**Volcado lógico (recomendado para `backup_plane.sql`):**

```bat
docker compose exec -T -e PGPASSWORD=plane plane-db pg_dump -U plane -d plane --no-owner --clean --if-exists > backup_plane.sql
```

**Restaurar en instancia vacía:**

```bat
docker compose up -d plane-db
docker compose exec -T -e PGPASSWORD=plane plane-db psql -U plane -d plane < backup_plane.sql
docker compose restart api worker web
```

**Volcado completo del cluster (pg_dumpall):**

```bat
docker compose exec -T -e PGPASSWORD=plane plane-db pg_dumpall -U plane > backup_plane_all.sql
```

---

## 5. Manual de operaciones

### 5.1 Arranque local

```bat
cd C:\Users\Arnold\Desktop\GneradorDeTicketsIntegrado
docker compose up -d --build
docker compose ps
```

### 5.2 Parar

```bat
docker compose down
```

### 5.3 Reset completo (DB limpia)

```bat
docker compose down -v
docker compose up -d --build
```

Luego: God Mode setup → workspace → proyectos → API key → actualizar `.env`.

### 5.4 Rebuild solo tickets / MCP

```bat
docker compose up -d --build floci-tickets plane-mcp
docker compose logs -f floci-tickets --tail 80
```

### 5.5 Health checks

```bat
curl http://localhost/api/instances/
curl http://localhost:5179/api/live
curl http://localhost:8211/healthz
curl http://localhost:5179/api/health
```

### 5.6 Ver variables en contenedor tickets

```bat
docker exec generador-tickets-integrado-floci-tickets-1 env | findstr PLANE_
```

---

## 6. Despliegue en Dokploy (producción)

### 6.1 Tipo de aplicación

- **Docker Compose**
- Repositorio / carpeta: raíz `GneradorDeTicketsIntegrado`
- Archivo: `docker-compose.yml`

### 6.2 Dominios sugeridos

| Servicio | Puerto contenedor | Dominio ejemplo |
| --- | --- | --- |
| `proxy` | 80 / 443 | `https://plane.tudominio.com` |
| `floci-tickets` | 5179 | `https://tickets.tudominio.com` |
| `plane-mcp` | 8211 | Opcional público; preferible solo red interna |

### 6.3 Variables obligatorias a cambiar respecto a local

```env
APP_DOMAIN=plane.tudominio.com
WEB_URL=https://plane.tudominio.com
CORS_ALLOWED_ORIGINS=https://plane.tudominio.com,https://tickets.tudominio.com
PLANE_WEB_URL=https://plane.tudominio.com
TICKETS_PUBLIC_URL=https://tickets.tudominio.com
SESSION_COOKIE_SECURE=true
SECRET_KEY=<nuevo>
LIVE_SERVER_SECRET_KEY=<nuevo>
SESSION_SECRET=<nuevo 32+ chars>
POSTGRES_PASSWORD=<fuerte>
RABBITMQ_PASSWORD=<fuerte>
PLANE_MCP_API_KEY=<token prod>
```

Mantener URLs **internas** como nombres Docker:

```env
PLANE_API_URL=http://api:8000
PLANE_MCP_URL=http://plane-mcp:8211/http/api-key/mcp
```

(`FLOCI_ENDPOINT` lo fija el compose en `http://floci:4566`.)

### 6.4 Migración de datos con `backup_plane.sql`

1. En local: generar `backup_plane.sql` (sección 4.5).
2. En Dokploy: levantar stack con volúmenes vacíos.
3. Copiar SQL al servidor o `docker compose exec -i plane-db psql ... < backup_plane.sql`.
4. Reiniciar `api`, `worker`, `web`.
5. Verificar login Plane y actualizar `.env` de tickets con slug/UUIDs/API key del entorno restaurado.

### 6.5 Build

Dokploy debe construir:

- `plane-mcp` desde `./plane-mcp-server`
- `floci-tickets` desde `./nuevo-ticket`

Plane core usa imágenes `makeplane/*:stable` (sin build local de `plane/`).

---

## 7. Estado de desarrollo

### 7.1 Probado y estable (oct 2026)

| Área | Estado |
| --- | --- |
| Stack Compose unificado | OK — `docker compose config` válido |
| Plane vía proxy `:80` | OK — servicios healthy |
| MCP `healthz` | OK — 200 |
| `floci-tickets` arranque | OK — tras fix `SESSION_COOKIE_SECURE` |
| Login formulario vs Plane API | OK — server-side `api:8000` |
| Volúmenes gestionados Compose | OK — sin `external` (portable Dokploy) |
| Mapeo `.env` wilsonws + TI/VENTAS + API key | OK — alineado con BD |

### 7.2 Parcial / depende de configuración

| Área | Notas |
| --- | --- |
| Creación ticket E2E | Requiere API key válida, proyectos existentes, Floci up |
| LLM análisis | `CURSOR_API_KEY` vacío → plantilla local |
| Adjuntos en Plane | Flujo presign v1; depende MinIO Plane |
| Imagen inline en UI Plane | Cambios en `plane/apps/api` (dev) no están en imagen `stable` hasta build custom |

### 7.3 Pendiente / roadmap

| Tarea | Descripción |
| --- | --- |
| **`GET /api/proyectos`** | Listar proyectos desde Plane API; eliminar UUIDs hardcoded |
| **Multi-workspace** | Selector de workspace en UI; hoy fijo `wilsonws` |
| **Rotación secretos** | `SECRET_KEY`, passwords DB/MQ, API keys antes de prod pública |
| **CI/CD Dokploy** | Pipeline build + migrate + smoke tests |
| **Monitoreo** | Alertas si `floci-tickets` 401 rate, MCP 5xx, api unhealthy |
| **Documentar backup automático** | Cron `pg_dump` + copia `floci-data` |

---

## 8. Referencia rápida de URLs locales

| Qué | URL |
| --- | --- |
| Plane (web) | http://localhost |
| God Mode | http://localhost/god-mode/ |
| Nuevo Ticket | http://localhost:5179 |
| MCP health | http://localhost:8211/healthz |
| API (solo debug desde host) | No publicada; usar proxy o `docker compose exec api` |

---

## 9. Archivos de código clave (floci-tickets)

| Archivo | Responsabilidad |
| --- | --- |
| `nuevo-ticket/server.js` | Express, rutas, cookie session, POST `/api/tickets` |
| `nuevo-ticket/lib/config.js` | Env validation, `PROJECTS`, `SESSION_COOKIE_SECURE` |
| `nuevo-ticket/lib/plane-auth.js` | Login email/password contra Plane |
| `nuevo-ticket/lib/plane-mcp.js` | Cliente MCP JSON-RPC over HTTP |
| `nuevo-ticket/lib/plane-attachments.js` | Presign + upload MinIO Plane |
| `nuevo-ticket/lib/llm.js` | Análisis Cursor SDK / plantilla |
| `nuevo-ticket/public/app.js` | UI login + submit con `credentials: same-origin` |
| `plane-mcp-server/server.py` | Starlette + mount MCP en `/http/api-key/mcp` |

---

## 10. Checklist: nuevo chat / nuevo desarrollador

1. Leer este `PROJECT_CONTEXT.md` y `.env.example`.
2. `docker compose up -d --build` desde la raíz.
3. Confirmar `wilsonws`, TI, VENTAS y API key en `.env` con consultas SQL sección 4.
4. Probar login + ticket en `:5179`.
5. Si sesión expulsa al crear ticket → revisar `SESSION_COOKIE_SECURE` y cookies en DevTools.
6. Para prod → Dokploy sección 6 + rotar secretos.

---

*Fin del documento maestro.*
