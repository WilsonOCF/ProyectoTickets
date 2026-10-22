> **Actualización 22/10/2026:** registro/login propios y autoría automática en Plane: ver [PORTAL_USUARIOS.md](./PORTAL_USUARIOS.md). Las secciones anteriores de autenticación con Plane son históricas.

# Contexto reconstruido — 22 octubre 2026

Base revisada: commit `18c7ce2`. Este documento complementa y actualiza los
documentos históricos; no certifica el estado actual del VPS.

## Estado comunicado por el usuario

El 21 de octubre se desplegó el proyecto en Dokploy y se añadió el webhook
de GitHub para redesplegar con cada push. Durante el despliegue se trataron
problemas de comunicación entre servicios y esperas de arranque/caché.
El despliegue y el webhook se registran como información del usuario: en esta
revisión no se consultaron Dokploy, GitHub ni los logs remotos.

## Arquitectura verificada en el repositorio

- Compose raíz: 16 servicios. Plane usa imágenes fijadas por digest; las
  carpetas fuente `plane/` y `floci/` no se construyen con este Compose.
- Se construyen `nuevo-ticket/` (Node/Express) y `plane-mcp-server/` (Python).
- Entrada HTTPS por Traefik; Plane pasa por Caddy (`proxy:80`) y el formulario
  por `floci-tickets:5179`. El Compose de producción no publica puertos al host.
- `tickets-net` conecta los servicios internamente; `egress` sirve a API y
  workers; `dokploy-network` conecta proxy, formulario, API, web y admin.
- Login del formulario contra `PLANE_WEB_URL`, pública, para conservar cookies
  Secure. Proyectos y adjuntos usan `http://proxy:80`; MCP usa `http://api:8000`.
- El formulario consulta proyectos dinámicos, crea tickets vía MCP y guarda
  archivos en Floci; los adjuntos nativos de Plane utilizan MinIO.
- Desarrollo local: override `docker-compose.local.yml`, Plane en localhost:3000
  y formulario en localhost:5179. No usar ese override en Dokploy.

## Cambios del 21 de octubre comprobados en Git

| Commit | Cambio efectivo |
| --- | --- |
| `5846b56` | Correcciones de infraestructura y retirada de `.env`/`.env.tmp` del seguimiento. |
| `80858dd` | Defaults locales, override local y comprobaciones de conectividad. |
| `c63c160` | Retira el healthcheck explícito de Caddy; formulario espera `service_started` del proxy. |
| `f1b0c93` | Añade web y API a `dokploy-network` para abordar el timeout de Caddy. |
| `c902861` | Añade flags de login/registro a backend, web y admin; conecta admin a `dokploy-network`. El servicio admin ya existía antes. |
| `18c7ce2` | Habilita `traefik.enable=true` en MCP. |

Estos cambios son evidencia del código aplicado, no de que todos los fallos
remotos hayan quedado resueltos.

## Arranque y caché

- Valkey tiene AOF y volumen persistente; healthcheck `valkey-cli ping` cada
  10 segundos, timeout de 3 segundos y 10 reintentos, sin `start_period` explícito.
- Migrator espera Postgres y Valkey saludables. API espera además RabbitMQ
  saludable y migrator terminado correctamente.
- API comprueba `/api/instances/`: margen inicial de 60 segundos, intervalo
  de 20 segundos, timeout de 10 segundos y 15 reintentos.
- Caddy espera web, space, admin y API saludables. Formulario espera API/MCP
  saludables, pero solo el arranque de Caddy y Floci.
- El entrypoint del backend fuente espera DB/migraciones, configura la instancia,
  crea el bucket, limpia caché y recolecta estáticos antes de Gunicorn. El comando
  fuente `wait_for_migrations` repite cada 10 segundos. Es código vendorizado;
  contrastar con la imagen fijada antes de diagnosticar producción con él.
- No se identificó en los commits revisados una ampliación específica de la
  espera de Valkey. No confundir caché de aplicación, caché de build y migraciones;
  hace falta el mensaje/log concreto para reconstruir ese incidente.

## Puntos pendientes y contradicciones documentales

1. MCP habilita Traefik pero el YAML raíz solo lo conecta a `tickets-net` y no
   define router público propio. Si se expuso mediante Domains en Dokploy,
   comprobar las redes y labels del Compose efectivo generado allí.
2. `AUDITORIA_DOKPLOY.md` describe una fase anterior: todavía afirma que no se
   desplegó, solo dos servicios están en la red externa y se exigen secretos
   sin defaults. Esas afirmaciones no describen el estado reconstruido actual.
3. `DOCKER_OPERACION.md` todavía describe un healthcheck de Caddy retirado por
   `c63c160`. Los documentos antiguos también conservan proyectos/puertos previos.
4. `/api/live` del formulario y `/healthz` de MCP verifican sus procesos, no el
   flujo completo. `/api/health` del formulario consulta S3; `mcpConfigured`
   solo comprueba que existe una cadena de token, no su validez.
5. Login no configura un timeout explícito de aplicación. Proyectos sí usa
   10 segundos por petición. La autorización de proyectos utiliza API key global,
   sin comprobar membresía individual del usuario autenticado.
6. Webhook: falta verificar rama configurada, última entrega y commit desplegado
   antes de afirmar que el HEAD local coincide con producción.

## Verificación de esta sesión

- `docker compose config --quiet`: correcto con entorno local existente.
- `docker compose -f docker-compose.yml --env-file .env.example config --quiet`:
  correcto. Valida configuración, no disponibilidad ni credenciales remotas.
- `.env` y `.env.tmp` de raíz ya no están en el índice Git; esto no elimina su
  historial ni demuestra rotación de credenciales.
- Contexto Docker seleccionado: `desktop-linux`, no el VPS.
- Al comenzar había un archivo sin seguimiento `deploy-dokploy.mjs`; se dejó
  intacto y no se ejecutó.
- No se cambió código runtime, no se hizo push y no se lanzó un redespliegue.

Para continuar, partir del Compose actual y de este documento. Contrastar con
el YAML efectivo y logs de Dokploy cuando se investigue un fallo remoto.
