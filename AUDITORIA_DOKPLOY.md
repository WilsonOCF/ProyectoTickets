> **Actualización 22/10/2026:** registro/login propios y autoría automática en Plane: ver [PORTAL_USUARIOS.md](./PORTAL_USUARIOS.md). Las secciones anteriores de autenticación con Plane son históricas.

# Auditoría de despliegue Dokploy — 21 octubre 2026

El Compose anterior no estaba preparado para este despliegue. El archivo raíz se corrigió, junto con los dos Dockerfiles, las dependencias Python del formulario y su login. La configuración valida y ambos builds completaron en Docker Linux/amd64. Todavía no se ha desplegado ni probado el flujo completo en `infra.crs-logistics.com`; no se ha accedido a su API ni verificado su configuración real.

## A. Hallazgos y correcciones

| Prioridad | Evidencia original | Consecuencia / resolución |
| --- | --- | --- |
| Crítica | `proxy.ports` publicaba 80 y 443 | Conflicto con Traefik si ya ocupa esos puertos. Eliminados todos los `ports`. |
| Crítica | Una sola red bridge `tickets-net`, sin red Dokploy ni labels | El YAML por sí solo no permitía a Traefik alcanzar/enrutar la aplicación. Añadida `dokploy-network` externa únicamente a `proxy` y `floci-tickets`, con routers TLS y puertos internos explícitos. Dokploy puede inyectar labels mediante Domains; este archivo usa labels manuales. |
| Alta | `plane-mcp.ports` publicaba 8211 y tickets publicaba 5179 | Acceso directo que evita TLS y controles del proxy. Eliminado. Postgres, Redis y API 8000 ya estaban sin publicación al host. |
| Crítica | Passwords DB/MQ por defecto `plane`; `DATABASE_URL` y `AMQP_URL` conservaban `plane:plane` | Rotar solamente las passwords hacía fallar API/migraciones/workers. Ahora ambas URLs se derivan de las passwords obligatorias, con usuario y base/vhost fijos `plane`. |
| Alta | Secretos Django/live de ejemplo y MinIO `access-key`/`secret-key` | Valores inseguros aceptados silenciosamente. Ahora se exige inyección sin default. Las credenciales `test` de Floci siguen siendo ficticias para el emulador privado; no son credenciales AWS reales ni una barrera de seguridad. |
| Crítica | `nuevo-ticket/lib/plane-auth.js` usaba `PLANE_API_URL=http://api:8000` para cookies | Plane activa cookies Secure al configurar orígenes HTTPS; el CookieJar no las devuelve sobre HTTP interno. Login usa ahora `PLANE_WEB_URL` HTTPS. El contenedor necesita resolver y alcanzar ese dominio y confiar en su certificado. No se desactivó Secure para resolverlo. |
| Alta | Adjuntos llaman a API directamente; Plane construye URLs firmadas con `request.get_host()` | La URL de subida podía ser `http://api:8000/uploads/...`, que Django no sirve. Tickets ahora usa `PLANE_API_URL=http://proxy:80`, que enruta `/api` y `/uploads`. MCP mantiene `http://api:8000`. `MINIO_ENDPOINT_SSL=0` permite que el esquema siga la petición: HTTPS externa, HTTP interna. No sustituir host/esquema después de firmar. |
| Crítica para primer uso | El formulario exige un token, pero una DB nueva no tiene usuarios/workspace/token | Una API key de la instancia local no existe en una instancia vacía. Se necesita bootstrap en dos etapas o restauración de la DB. No se fabrica una API key de Plane con un generador aleatorio. |
| Crítica de secretos | `git ls-files` incluye `.env` y `.env.tmp`; `PROJECT_CONTEXT.md` contenía un token identificado como real | `.gitignore` no retira archivos ya versionados. Se amplió el ignore y se redactaron tokens en el documento actual. Los archivos y el historial aún requieren saneamiento y rotación; no se reescribió historial ni se borraron archivos locales. |
| Alta | `stable`, `latest`, bases Docker mutables; MCP copiaba site-packages a otra base Python | Builds/deploys podían variar y mezclar bibliotecas nativas incompatibles. Imágenes del Compose fijadas a digests del conjunto instalado; Node fijado; MCP deriva directamente de su upstream fijado. Dependencias Python directas/transitivas fijadas a las versiones verificadas. |
| Media | 1.000 conexiones Postgres; sin rotación de logs Docker; RabbitMQ sin hostname estable | Eliminado el override de conexiones, añadida rotación 10 MiB × 3 por contenedor y hostname persistente de RabbitMQ. Valkey activa AOF. Migrator termina con error visible en lugar de reiniciar indefinidamente. |
| Media | Formulario acepta archivos de 10 MiB; Plane limitaba a 5 MiB | Default Plane alineado a 10 MiB. El overhead multipart puede alcanzar el límite del proxy para archivos exactamente del tamaño máximo; validar tamaños reales y ajustar `FILE_SIZE_LIMIT` si corresponde. |

El alcance revisado cubre el Compose raíz, documentos, configuración y rutas runtime del formulario/MCP, archivos de build y lock, ignores e índice Git, settings de autenticación/storage de Plane, Caddy y scripts de la imagen backend instalada. Las carpetas completas de Plane y Floci no se construyen con este Compose; no se afirma una auditoría exhaustiva de vulnerabilidades de todo su código vendorizado.

## B. Compose corregido

El entregable completo es [docker-compose.yml](./docker-compose.yml), no un fragmento. Requiere incluir también los cambios de [plane-auth.js](./nuevo-ticket/lib/plane-auth.js), ambos Dockerfiles y [requirements.txt](./nuevo-ticket/requirements.txt).

| Red | Miembros | Propósito |
| --- | --- | --- |
| `tickets-net`, bridge, `internal: true` | Los 16 servicios | DNS/comunicación privada del stack; datos sin salida directa a Internet. No es segmentación entre todos los componentes: comparten confianza interna. |
| `egress`, bridge | API, worker, beat-worker | Salida para integraciones, SMTP y webhooks; sin puertos host. |
| `dokploy-network`, externa | Solo `proxy` y `floci-tickets` | Entrada desde Traefik y salida del formulario para login HTTPS/Cursor. La red debe existir y Traefik debe estar conectado. |

Solo el Traefik del servidor publica 80/443. TLS termina allí; Caddy escucha HTTP `:80` y conserva el enrutamiento de Plane (web, admin, space, live, api, auth y uploads). Los labels incluyen `traefik.enable=true`, red explícita, regla Host, entrypoint `websecure`, resolver `letsencrypt`, servicio y puerto 80/5179, más redirección HTTP a HTTPS. Los otros 14 servicios llevan `traefik.enable=false`. `expose` documenta puertos internos; no publica ni restringe el acceso entre miembros de una red.

Esta estrategia de labels manuales está soportada por [Dokploy](https://docs.dokploy.com/docs/core/docker-compose/domains). No registrar simultáneamente estos mismos hosts en Domains sin retirar los routers manuales. Los entrypoints/resolver siguen el [ejemplo oficial](https://docs.dokploy.com/docs/core/docker-compose/example), pero deben existir con esos nombres en el servidor destino. El label de red evita elegir una IP de la red privada cuando un contenedor tiene varias redes; véase [Traefik Docker](https://doc.traefik.io/traefik/reference/routing-configuration/other-providers/docker/).

Configuración de aprovisionamiento: `composeType=docker-compose`, fuente Git, directorio raíz y `composePath=./docker-compose.yml`. Docker Stack no admite estos builds. Usar un appName/proyecto Compose estable y desactivar reescritura/aislamiento automático que cambie redes o volúmenes; inspeccionar el YAML efectivo que Dokploy despliega. No habilitar volúmenes nuevos por cada release. Se eliminó el `name:` fijo para que Dokploy controle el nombre del proyecto.

### Persistencia

Todos los mounts son volúmenes nombrados: `pgdata`, `redisdata`, `rabbitmq_data`, `uploads`, `floci-data`, `proxy_config`, `proxy_data` y cuatro `logs_*`. Ya eran named volumes en el original; no había bind mounts relativos en este Compose. Las rutas `build.context` son contextos de build, no mounts de datos.

No hay migración automática desde los volúmenes del PC al VPS. Cambiar el proyecto Compose crea otros nombres físicos de volumen. Para datos existentes, preservar/migrar las credenciales y el volumen; cambiar `POSTGRES_PASSWORD` en el entorno no cambia el password de un usuario PostgreSQL ya inicializado. El hostname fijado de RabbitMQ está destinado a una instalación nueva; migrar expresamente su estado si ya existía. Programar backup/restauración consistente de Postgres y ambos almacenes de archivos. Named volumes sobreviven a recreaciones, pero no sustituyen backups ni sobreviven a `down -v`.

### Portabilidad y reproducibilidad

Los dos contextos existen y sus COPY están versionados; no dependen de `.cmd`, rutas Windows, `.venv` local ni bind mounts. Las allowlists de `.dockerignore` impiden copiar `.env`. `npm ci --omit=dev` usa el lock. Las rutas Linux y los usuarios no-root se comprobaron durante el build.

Los digests se obtuvieron de imágenes locales inspeccionadas para Linux/amd64, incluyendo el conjunto Plane que ya se usaba. No son una selección de versiones actualizadas ni una certificación de ausencia de CVEs. Validar disponibilidad del digest en registry y arquitectura del VPS; para ARM se necesita verificar manifest/SDK y reconstruir/probar el conjunto correspondiente. No mezclar versiones arbitrarias de los seis componentes Plane.

No se promete reproducibilidad bit a bit: `apt-get` todavía depende de repositorios Debian variables y pip no usa hashes. Para despliegues idénticos, construir en CI, escanear y publicar las dos imágenes propias por digest; para builds herméticos, fijar snapshots Debian y hashes Python. La imagen base MCP fijada evita copiar módulos nativos entre distribuciones diferentes.

## C. Entorno exacto

El Compose original exigía mediante `${VAR:?}` solamente cuatro variables: `SESSION_SECRET`, `PLANE_WEB_URL`, `PLANE_WORKSPACE_SLUG` y `PLANE_MCP_API_KEY`. En producción Node exige nueve variables, pero Compose suministraba las otras cinco. `SESSION_SECRET` debe tener al menos 32 caracteres. Que una variable no fuera requerida por interpolación no hacía seguros sus defaults.

El Compose corregido requiere exactamente estos **11 pares** para el despliegue completo. Los dominios son una propuesta; no se verificó su DNS. `infra.crs-logistics.com` se trata como panel/API de Dokploy, no como dominio de la aplicación.

```dotenv
PLANE_DOMAIN=plane.crs-logistics.com
TICKETS_DOMAIN=tickets.crs-logistics.com
POSTGRES_PASSWORD=<HEX_ALEATORIO_64_DB>
RABBITMQ_PASSWORD=<HEX_ALEATORIO_64_MQ>
AWS_ACCESS_KEY_ID=plane-storage
AWS_SECRET_ACCESS_KEY=<HEX_ALEATORIO_64_STORAGE>
SECRET_KEY=<HEX_ALEATORIO_64_DJANGO>
LIVE_SERVER_SECRET_KEY=<HEX_ALEATORIO_64_LIVE>
SESSION_SECRET=<HEX_ALEATORIO_64_SESSION>
PLANE_WORKSPACE_SLUG=crs
PLANE_MCP_API_KEY=<TOKEN_REAL_EMITIDO_POR_PLANE_DESTINO>
```

Los marcadores se sustituyen, no se envían literalmente. Generar seis secretos distintos, por ejemplo con `openssl rand -hex 32` una vez para cada valor. DB/MQ deben ser hexadecimales con esta plantilla: se insertan en URLs sin percent-encoding. MinIO requiere una contraseña de al menos 8 caracteres; 64 hex satisface ese requisito. No enviar estos secretos en labels ni build args. El token debe pertenecer al workspace destino y tener permisos de lectura de proyectos, creación de work items y adjuntos.

Las URLs WEB/PLANE_WEB/TICKETS y CORS se derivan de los dos dominios (host solamente, sin protocolo, puerto ni path). DATABASE_URL y AMQP_URL se derivan de las passwords. No hay que enviar `APP_DOMAIN`, `APP_RELEASE`, `WEB_URL`, `PLANE_WEB_URL`, `CORS_ALLOWED_ORIGINS`, `DATABASE_URL`, `AMQP_URL`, `PLANE_API_URL`, `SESSION_COOKIE_SECURE` ni puertos host. Tampoco IDs de proyecto: se descubren dinámicamente.

Opcionales: `CURSOR_API_KEY` (omitida: plantilla local), `LLM_MODEL` (auto), `ROUTER_PREFIX` (crs-tickets; cambiar para otra instancia en el mismo Traefik). Otros overrides soportados están documentados directamente por los `${VAR:-default}` del Compose. No reutilizar el `.env` local: contiene valores viejos y secretos que deben rotarse.

La [API de Dokploy](https://docs.dokploy.com/docs/api/compose) recibe `env` como **string dotenv**, no como objeto de pares. Ejemplo ejecutable desde el proceso de aprovisionamiento Node, cargando el archivo seguro ya completado:

```js
import { readFile } from 'node:fs/promises';
const env = await readFile(process.env.DEPLOY_ENV_FILE, 'utf8');
const response = await fetch('https://infra.crs-logistics.com/api/compose.saveEnvironment', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': process.env.DOKPLOY_API_KEY,
  },
  body: JSON.stringify({ composeId: process.env.DOKPLOY_COMPOSE_ID, env, createEnvFile: true }),
});
if (!response.ok) throw new Error(`compose.saveEnvironment HTTP ${response.status}`);
```

`DOKPLOY_API_KEY`, `DOKPLOY_COMPOSE_ID` y `DEPLOY_ENV_FILE` son datos del aprovisionador, no variables de contenedores. El archivo debe contener los 11 pares anteriores ya resueltos. Guardar entorno no despliega: ejecutar después `compose.deploy` y comprobar resultado/logs. La sintaxis requerida `${VAR:?}` falla antes del arranque si falta un valor; véase [Docker Compose interpolation](https://docs.docker.com/reference/compose-file/interpolation/).

### Bootstrap de una DB vacía

1. Configurar DNS y los dos hosts; generar secretos y conservarlos para todos los despliegues siguientes.
2. Para poder interpolar el YAML antes de tener token, usar temporalmente `PLANE_MCP_API_KEY=BOOTSTRAP_NOT_A_REAL_TOKEN`. Desplegar **solo** `proxy plane-mcp floci`, con comando Compose `up -d --build proxy plane-mcp floci`. Sus dependencias levantan Plane; `floci-tickets` no arranca. Es un marcador exclusivo para esta fase, no una credencial válida.
3. Entrar por HTTPS a Plane `/god-mode/`, completar instancia, crear usuario/workspace `crs` y proyectos, emitir un token de cuenta de servicio con permisos adecuados.
4. Sustituir el marcador vía `compose.saveEnvironment`, conservar el resto de valores y cambiar al comando completo `up -d --build`. Desplegar de nuevo.
5. Verificar login del formulario, lista de proyectos, creación de ticket, carga y descarga de adjunto tanto desde tickets como desde la UI Plane, y persistencia tras recrear contenedores.

Si se requiere cero intervención humana, falta implementar un bootstrap de negocio idempotente para usuarios/workspace/token usando las interfaces admitidas por la versión fijada. El Compose por sí solo no hace ese aprovisionamiento. Restaurar una DB existente con sus secretos y token es otra opción.

## Validación y condiciones de salida

- `docker compose --env-file .env.example config --quiet`: correcto. Verifica sintaxis con marcadores; no su validez operativa.
- Comprobación del JSON resuelto: 16 servicios, cero host ports, solo dos servicios conectados/habilitados en Traefik, todos los mounts persistentes tipo volume.
- Build Linux de `floci-tickets` y `plane-mcp`: correcto, con caché parcial de capas; no es prueba de un VPS limpio sin caché.
- Prueba del login con respuestas simuladas y CookieJar real: devuelve cookies Secure de CSRF y sesión a las tres rutas HTTPS; pasa.
- Importación del upstream MCP y creación de su aplicación HTTP bajo el usuario de la imagen: pasa. Hay avisos de deprecación Authlib del upstream, no fallos.
- No se ejecutó un despliegue integral, migración de datos, escaneo de CVEs, prueba SMTP/Cursor, certificados, ni un ticket real en el VPS.

Antes de publicar: rotar las credenciales expuestas, retirar `.env`/`.env.tmp` del seguimiento Git preservando copias locales seguras, revisar y sanear historial según su exposición, y no compartir el token redactado. Añadir un ignore no elimina lo que ya estaba en el índice. No se cambió el índice ni se reescribió historial durante esta auditoría.

También queda revisar política de autorización: el formulario autentica un usuario, pero lista proyectos y crea tickets con una API key global; no revalida la pertenencia/permisos por usuario ni la revocación de su sesión Plane durante las 12 horas de cookie. No tiene límite de intentos de login ni de creación, y mantiene hasta 100 MiB de archivos por petición en memoria. Son riesgos concretos del código para una exposición pública; necesitan controles de aplicación/capacidad acordes al uso. Un healthcheck saludable no garantiza tokens válidos, permisos correctos ni adjuntos subidos: el código puede devolver ticket creado con errores individuales de adjuntos.
