> **Actualización 22/10/2026:** registro/login propios y autoría automática en Plane: ver [PORTAL_USUARIOS.md](./PORTAL_USUARIOS.md). Las secciones anteriores de autenticación con Plane son históricas.

# Contexto de despliegue — GeneradorDeTicketsIntegrado
> **Producción (21 octubre 2026):** la guía vigente es [AUDITORIA_DOKPLOY.md](./AUDITORIA_DOKPLOY.md). El Compose raíz ahora requiere Dokploy/Traefik, no publica puertos y utiliza `.env.example` actualizado. Las instrucciones locales y variables de abajo se conservan como histórico.
> Actualizacion: proyectos dinamicos implementados. GET /api/proyectos consulta Plane con la API key del servidor (requiere sesion). El formulario carga nombres y UUIDs al abrirse; POST /api/tickets valida project_id contra el workspace. El analisis local y LLM respetan la seleccion. No se requieren variables por proyecto. Las referencias al mapeo TI/VENTAS que siguen son historicas.


**Última actualización:** 20 octubre 2026  
**Raíz del repo:** `C:\Users\Arnold\Desktop\GneradorDeTicketsIntegrado`  
**Documento maestro (arquitectura, auth, BD, `.env`, roadmap):** [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md)  
**Objetivo:** guía operativa resumida; el detalle exhaustivo está en `PROJECT_CONTEXT.md`.

---

## 1. Resumen del ecosistema

Este monorepo integra **cuatro piezas** que antes se levantaban por separado:

| Pieza | Carpeta | Rol |
| --- | --- | --- |
| **Plane** | `plane/` | Gestión de proyectos/tickets (Community). API Django, UI web, admin, workers, Postgres, Redis, RabbitMQ, MinIO. |
| **plane-mcp** | `plane-mcp-server/` | Servidor MCP en HTTP que expone herramientas para crear work items y adjuntos en Plane usando API key + workspace slug. |
| **floci-tickets** | `nuevo-ticket/` | Formulario web (Node/Express) con login contra Plane, análisis opcional con Cursor SDK, backup S3 y creación de tickets vía MCP. |
| **Floci** | imagen `floci/floci:latest` | Emulador S3 compatible (puerto 4566) para guardar adjuntos del formulario. **No** es el MinIO de Plane. |

### Flujo de datos (alto nivel)

```text
Usuario → floci-tickets:5179
           ├─ login / sesión → PLANE_API_URL (api:8000) + PLANE_WEB_URL (público)
           ├─ adjuntos → FLOCI_ENDPOINT (floci:4566) bucket tickets
           └─ crear ticket → PLANE_MCP_URL (plane-mcp:8211) + PLANE_MCP_API_KEY

plane-mcp → PLANE_INTERNAL_BASE_URL / PLANE_BASE_URL → api:8000

Plane (usuarios normales) → proxy:80 → web / api / admin / space / live
```

---

## 2. Arquitectura de red

### Red Docker

- **Nombre:** `tickets-net` (bridge), definida en `docker-compose.yml`.
- **Regla:** entre contenedores se usan **nombres de servicio**, no `localhost` ni `127.0.0.1`.

### Servicios y DNS interno

| Servicio Compose | Hostname en red | Puerto interno | Uso |
| --- | --- | --- | --- |
| `api` | `api` | 8000 | API Plane |
| `web` | `web` | (interno) | Frontend Plane |
| `admin` | `admin` | (interno) | God mode |
| `proxy` | `proxy` | 80, 443 | Entrada pública Plane |
| `plane-db` | `plane-db` | 5432 | Postgres |
| `plane-redis` | `plane-redis` | 6379 | Valkey/Redis |
| `plane-mq` | `plane-mq` | 5672 | RabbitMQ |
| `plane-minio` | `plane-minio` | 9000 | Object storage Plane |
| `plane-mcp` | `plane-mcp` | 8211 | MCP HTTP |
| `floci` | `floci` | 4566 | S3 emulado |
| `floci-tickets` | `floci-tickets` | 5179 | Formulario Nuevo Ticket |

### Puertos publicados al host (local)

| Puerto host | Servicio | URL típica |
| --- | --- | --- |
| 80 / 443 | `proxy` | `http://localhost` (Plane) |
| 5179 | `floci-tickets` | `http://localhost:5179` |
| 8211 | `plane-mcp` | `http://localhost:8211/healthz` (opcional exponer) |

Los demás servicios solo tienen `expose` (accesibles desde otros contenedores en `tickets-net`).

### Desarrollo “viejo” vs stack unificado

| Antes (dev en PC) | Stack Compose |
| --- | --- |
| `pnpm dev` web :3000 | Plane UI vía **proxy :80** (imágenes `makeplane/*`) |
| API `docker-compose-local` :8000 | `api:8000` detrás del proxy |
| MCP `127.0.0.1:8211` | `plane-mcp:8211` |
| Floci `127.0.0.1:4566` | `floci:4566` |

**CSRF / localhost:** en dev con Vite había que alinear `localhost` vs `127.0.0.1`. En Dokploy uses dominios HTTPS en `WEB_URL`, `PLANE_WEB_URL` y `CORS_ALLOWED_ORIGINS`.

---

## 3. Estructura del `docker-compose.yml` maestro

Archivo: **`docker-compose.yml`** en la raíz (no modifica código de las apps).

### Bloques principales

1. **Datos:** `plane-db`, `plane-redis`, `plane-mq`, `plane-minio` + volúmenes.
2. **Plane app:** `migrator` → `api` (healthcheck) → `worker`, `beat-worker`, `web`, `space`, `admin`, `live` → `proxy`.
3. **Integración:** `plane-mcp` (depende de `api` healthy), `floci`, `floci-tickets` (depende de `api`, `plane-mcp`, `floci`).

### Orden de arranque (`depends_on`)

```text
plane-db, plane-redis, plane-mq  (healthchecks)
    → migrator (completed_successfully)
    → api (healthy)
    → worker / beat-worker / web / …
    → proxy

api (healthy) → plane-mcp (healthy)
api + plane-mcp + floci → floci-tickets
```

### Volúmenes persistentes

| Volumen | Contenido |
| --- | --- |
| `pgdata` | Postgres Plane |
| `redisdata` | Redis/Valkey |
| `rabbitmq_data` | RabbitMQ |
| `uploads` | MinIO Plane |
| `floci-data` | Adjuntos S3 del formulario |
| `proxy_config`, `proxy_data` | Proxy / TLS |
| `logs_*` | Logs backend |

Los volúmenes los crea Compose (`generador-tickets-integrado_*`). Para **reset total**: `docker compose down -v`.

### Variables

- **Raíz:** `.env` (generado; ver sección 6).
- **Plantilla documentada:** `.env.example`.
- **`.gitignore`** ignora `.env`.

---

## 4. Instrucciones de prueba local

### Requisitos

- Docker Desktop (Linux containers).
- Puertos libres: **80**, **443**, **5179**, **8211** (o ajustar en `.env`).

### Levantar

```bat
cd C:\Users\Arnold\Desktop\GneradorDeTicketsIntegrado
docker compose up -d --build
```

Primera vez: descarga imágenes `makeplane/*` y construye `plane-mcp` + `floci-tickets` (varios minutos).

### Verificar

```bat
docker compose ps
docker compose logs -f api --tail 50
docker compose logs -f plane-mcp floci-tickets --tail 50
```

| Comprobación | Comando / URL |
| --- | --- |
| API Plane | `curl http://localhost/api/instances/` (vía proxy) o logs `api` |
| MCP vivo | `curl http://localhost:8211/healthz` |
| Formulario | Abrir `http://localhost:5179` |
| Plane UI | `http://localhost` |

### Detener

```bat
docker compose down
```

**No uses** `docker compose down -v` salvo que quieras borrar Postgres y datos.

### Si el puerto 80 está ocupado

Edita `.env`: `LISTEN_HTTP_PORT=8080` y usa `http://localhost:8080` como `WEB_URL` / `PLANE_WEB_URL`.

---

## 5. Guía de despliegue en Dokploy

### Tipo de aplicación

- **Docker Compose**
- Directorio raíz del repositorio
- Archivo: `docker-compose.yml`

### Variables de entorno

- Copiar desde `.env.example` o el `.env` local ya generado.
- Pegar en **Environment** de Dokploy (no commitear secretos).
- **Cambiar obligatoriamente en producción:**
  - `APP_DOMAIN`, `WEB_URL`, `PLANE_WEB_URL` → `https://tu-dominio-plane`
  - `CORS_ALLOWED_ORIGINS` → incluir dominio Plane + dominio del formulario
  - `SECRET_KEY`, `LIVE_SERVER_SECRET_KEY`, `SESSION_SECRET`, `POSTGRES_PASSWORD`, `RABBITMQ_PASSWORD`
  - `CERT_EMAIL` si usas HTTPS automático en `proxy`

### Dominios sugeridos

| Servicio Compose | Puerto contenedor | Dominio Dokploy |
| --- | --- | --- |
| `proxy` | 80 (y 443) | `plane.tudominio.com` |
| `floci-tickets` | 5179 | `tickets.tudominio.com` |
| `plane-mcp` | 8211 | Opcional; puede quedar solo en red interna si el formulario llama por `http://plane-mcp:8211/...` |

### Build

- Dokploy debe poder hacer `docker compose build` para `plane-mcp` y `floci-tickets`.
- `APP_RELEASE=stable` usa imágenes oficiales Plane (sin build local de Plane).

### Notas Dokploy

- `floci-tickets` con `NODE_ENV=production` **rechaza** URLs con `localhost` en `PLANE_API_URL`, `PLANE_MCP_URL`, `FLOCI_ENDPOINT` (el compose ya fija internos).
- `PLANE_WEB_URL` debe ser la URL que el **usuario** abre en el navegador (HTTPS pública).

---

## 6. Estado actual y próximos pasos

### Listo

- [x] `docker-compose.yml` maestro unificado
- [x] `.env.example` documentado
- [x] `.env` en raíz con valores tomados de configs locales (ver abajo)
- [x] `docker compose config` validado (sintaxis YAML)
- [x] `.gitignore` para `.env`
- [x] Este documento `CONTEXTO_DESPLIEGUE.md`

### Falta probar (checklist)

- [ ] `docker compose up -d --build` completo en la máquina de Wilson (primera descarga)
- [ ] Login Plane en `http://localhost` con usuarios existentes en volumen **nuevo** (DB vacía si es primera vez)
- [ ] Crear ticket desde `http://localhost:5179` end-to-end (MCP + Floci + adjunto)
- [ ] Rotar secretos débiles (`LIVE_SERVER_SECRET_KEY=secret-key`, passwords `plane/plane`) antes de producción
- [ ] Despliegue real en Dokploy con dominios HTTPS

### Sesión `floci-tickets` (login → crear ticket te expulsa)

Causa habitual: cookie `nt_session` con `Secure` en HTTP. Con `NODE_ENV=production` antes se forzaba `secure: true`; el navegador en `http://localhost:5179` **no guardaba** la cookie y el POST `/api/tickets` devolvía **401** → la UI vuelve al login.

**Corrección:** `SESSION_COOKIE_SECURE=false` y `TICKETS_PUBLIC_URL=http://localhost:5179` en `.env` / Compose. En Dokploy con HTTPS: `TICKETS_PUBLIC_URL=https://tickets...` y `SESSION_COOKIE_SECURE=true`.

URLs internas (`PLANE_API_URL`, `PLANE_MCP_URL`, `FLOCI_ENDPOINT`) deben ser nombres Docker (`api`, `plane-mcp`, `floci`). `PLANE_WEB_URL` es la URL pública de Plane para enlaces (`http://localhost` en local).

### Puntos de falla habituales

| Síntoma | Revisar |
| --- | --- |
| `floci-tickets` reinicia con `PLANE_WEB_URL apunta a la propia aplicación` | `PLANE_WEB_URL` no puede ser `localhost`; usar `host.docker.internal` (local) o dominio HTTPS |
| `floci-tickets` no arranca | Logs: variables requeridas; `SESSION_SECRET` ≥ 32 chars; URLs internas `api` / `plane-mcp` / `floci` |
| MCP 401/403 | `PLANE_MCP_API_KEY` válida; workspace `crs`; API key con permisos |
| Plane CSRF en dev Vite | No aplica al stack proxy; si vuelves a `pnpm dev`, usar solo `localhost` |
| `api` unhealthy | Postgres/MQ; logs `migrator`; esperar más en primer boot |
| Puerto 80 en uso | Cambiar `LISTEN_HTTP_PORT` o parar IIS/otro proxy |
| Adjuntos Plane vs Floci | Plane usa `plane-minio`; formulario usa `floci` — son buckets distintos |

### Archivos de referencia históricos

- `plane/deployments/cli/community/docker-compose.yml` — base del stack Plane
- `nuevo-ticket/docker-compose.yml` — solo app + floci (Dokploy parcial)
- `plane-mcp-server/docker-compose.yml` — MCP + Valkey (no usado en maestro; MCP custom sin Valkey)
- Escritorio: `plane-login-csrf-solucion.md`, `plane-ips-csrf-analisis-completo.md`

### Mapeo del `.env` raíz (origen de valores)

Ver respuesta del agente que generó `.env` (lista real vs default). Resumen:

- **Reales:** secretos y credenciales de `plane/apps/api/.env`, DB/MQ de Plane, IDs de proyecto y MCP/LLM de `nuevo-ticket/.env`, `USE_MINIO` y MinIO de `plane/.env`.
- **Adaptados para Docker:** `PLANE_*_URL` internos → `http://api:8000`, `http://plane-mcp:...`, `http://floci:4566`; `PLANE_WEB_URL` → `http://localhost` (proxy).
- **Por defecto / placeholder:** `CERT_EMAIL`, `WEBHOOK_*`, dominios `*.example.com` sustituidos por `localhost` para prueba local; `FLOCI_AWS_*=test`; `SESSION_SECRET` ampliado respecto al `.env` original del formulario.

---

## 7. Arranque en blanco + configurar tickets

### Borrar todo y levantar de cero

```bat
cd C:\Users\Arnold\Desktop\GneradorDeTicketsIntegrado
docker compose down -v
docker compose up -d --build
```

Opcional: borrar volúmenes huérfanos viejos (`plane_pgdata`, `generador-tickets-integrado_*`) con `docker volume ls` y `docker volume rm`.

### Primer uso de Plane (instancia vacía)

1. Abrir `http://localhost/god-mode/` y completar **Instance setup** (admin email + contraseña).
2. Entrar a `http://localhost`, crear workspace con slug **`crs`** (o cambiar `PLANE_WORKSPACE_SLUG` en `.env`).
3. Crear proyectos **TI** y **Ventas**; copiar sus UUID desde la URL del proyecto o API.
4. **API key:** Perfil → API tokens → crear token con permisos de workspace.
5. Editar `.env`:
   - `PLANE_MCP_API_KEY=plane_api_...`
6. `docker compose up -d --build floci-tickets` (o reiniciar el servicio).

El formulario valida login con **email/contraseña de Plane** (no la API key). La API key solo usa MCP/adjuntos al crear el ticket.

## 8. Comandos rápidos (copiar/pegar)

```bat
cd C:\Users\Arnold\Desktop\GneradorDeTicketsIntegrado
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs -f floci-tickets
docker compose restart plane-mcp floci-tickets
docker compose down
```
