# Registro propio y autoría en Plane — 22 octubre 2026

Este documento describe el flujo nuevo. Sustituye las secciones de autenticación
del formulario de PROJECT_CONTEXT.md, CONTEXTO_DESPLIEGUE.md y AUDITORIA_DOKPLOY.md.

## Comportamiento

1. La persona se registra con nombre, correo y contraseña de 12–128 caracteres.
   Su cuenta se guarda solo en el portal. Registro y login no llaman a Plane.
2. La sesión permite consultar los proyectos que ve la API key de integración.
3. Al enviar el primer ticket, el backend valida el proyecto y envía la identidad
   obtenida de su sesión al bridge privado. No acepta un autor enviado por el navegador.
4. En una transacción, el bridge crea una identidad humana de Plane (nombre y
   correo del registro, contraseña inutilizable), su perfil y sus membresías:
   Guest (5) en el workspace y Member (15) en cada proyecto al que envía.
5. Crea el work item con el serializer de la versión fijada de Plane y el contexto
   de auditoría de esa identidad. `created_by` y el actor del evento son la persona.
   No depende de que la API pública admita sobrescribir `created_by`.
6. El formulario sigue cargando adjuntos nativos mediante la API de Plane y copias
   en Floci. La autoría de esos adjuntos usa la API key de integración existente.
7. La respuesta al usuario contiene el número del ticket; no requiere abrir Plane.
   La descripción generada ya no incluye una sección automática «Reportado por».

La creación de tickets del portal pasa ahora por `plane-ticket-bridge`, no por
MCP. El servicio MCP y sus routers se conservan para sus otros consumidores.
`PLANE_MCP_API_KEY` sigue siendo necesaria para consultar proyectos y adjuntar archivos.

## Persistencia y sesiones

- SQLite en `/app/data/portal.sqlite`, nuevo volumen **tickets-users**.
- Hashes scrypt con sal aleatoria por cuenta; no se guarda ni copia la contraseña
  a Plane. Las claves de sesión solo se almacenan como SHA-256 en la base.
- Cookie firmada `nt_portal_session`, HttpOnly, SameSite=Lax y Secure según la
  configuración existente. Duración de 12 horas también comprobada en el servidor.
- Logout revoca la sesión en la base; reutilizar una cookie anterior no la recupera.
- Las sesiones antiguas de login Plane no se migran. Se necesita registrarse en el portal.
- Límites de intentos de registro/login, protección de mutaciones con cabecera
  del mismo origen, consultas parametrizadas y límite de envíos antes de recibir adjuntos.
- Registro abierto por defecto para desarrollo. No incluye verificación de correo
  ni recuperación de contraseña; el nombre/correo son declarados por el usuario.
  Antes de abrir un portal público, definir verificación/recuperación o un proveedor
  de identidad. `TICKETS_REGISTRATION_ENABLED=false` cierra nuevos registros.
- SQLite está pensado para una única instancia del formulario con su volumen local.
  No desplegar réplicas repartidas entre nodos con copias distintas de esa base.

## Reintentos y cuentas existentes

El navegador envía un UUID de idempotencia y lo conserva en sessionStorage para
reintentos del mismo contenido. El servidor vincula esa clave al usuario y a una
huella de campos y bytes de archivos. Rechaza reutilizarla con otro contenido.

El bridge usa bloqueos transaccionales de PostgreSQL y `external_id` para evitar
duplicar usuarios/tickets incluso con peticiones concurrentes o reinicios. La
identidad se vincula por un username interno `tickets_<UUID del portal>`, no por
coincidencia de email sin verificar. El portal también guarda el ID de Plane.

Si el correo ya existe en Plane sin esa vinculación, se responde con un conflicto
que requiere revisión administrativa. No se cambia su contraseña, nombre ni permisos.
No se implementó una herramienta automática de vinculación de cuentas preexistentes.
Una membresía suspendida o retirada no se reactiva automáticamente.

La creación de identidad/membresías/ticket es atómica; los adjuntos y respaldos
son operaciones posteriores. Un fallo de adjuntos devuelve éxito del ticket con
advertencia. Los reintentos después de una caída durante la carga pueden requerir
revisión de adjuntos; la garantía de no duplicación cubre el work item. Los eventos
de actividad se publican después del commit; si RabbitMQ falla, se registra el
error en el bridge y el ticket creado se conserva (no hay outbox de eventos).

Guest en workspace + Member en proyecto no es un permiso «solo enviar»: Member
puede tener acceso a otros work items de ese proyecto. El portal no entrega
credenciales de Plane, pero la membresía es real. No se otorga rol Admin.

## Despliegue Dokploy

El Compose raíz tiene ahora **17 servicios**. Conserva imágenes y redes existentes,
routers Traefik, puertos de entrada, nombres de volúmenes previos y orden de migraciones.

- Nuevo build `./plane-ticket-bridge`, basado en el **mismo digest que api/migrator**.
  Ejecuta Gunicorn como UID 10001; solo se conecta a `tickets-net`, con Traefik
  deshabilitado y sin puertos publicados. No añadirle un dominio público.
- El formulario monta `tickets-users:/app/data`; la imagen prepara el directorio
  con propietario `node` para permitir el primer arranque sin ejecutar como root.
- El bridge espera la API saludable; el formulario espera además al bridge saludable.
- `TICKETS_BRIDGE_SECRET` es opcional y, si falta, deriva de `SESSION_SECRET`,
  compartido únicamente entre ambos servicios en esta integración. Se puede configurar
  un secreto independiente de al menos 32 caracteres. No cambiar secretos existentes
  de PostgreSQL, MinIO ni RabbitMQ para aplicar esta actualización.
- `TICKETS_REGISTRATION_ENABLED=true` habilita el registro. El Compose configura
  automáticamente `PLANE_BRIDGE_URL=http://plane-ticket-bridge:8220` y la ruta SQLite.
- Mantener `PLANE_WORKSPACE_SLUG` y una API key válida de la instancia desplegada.
  Los proyectos del formulario siguen siendo los accesibles con esa API key.
- No hay que tocar el webhook: al publicar el commit, el despliegue debe construir
  formulario y bridge. Si Dokploy usa un comando con servicios explícitos, incluir
  `plane-ticket-bridge` y `floci-tickets`, o usar el `up -d --build` del stack completo.
- No usar `down -v`. Mantener el mismo nombre de proyecto Compose. Incluir el nuevo
  volumen en backups; detener el formulario al copiar SQLite o usar su API de backup
  para evitar una copia inconsistente con WAL. Conservar también Postgres y adjuntos.
- Al actualizar Plane en el futuro, actualizar y probar juntos API, migrator,
  workers y la base del bridge. El bridge usa interfaces Python de esa versión.

El Compose independiente de `nuevo-ticket/` requiere una URL de bridge privado
alcanzable y su secreto. Para este repositorio, el despliegue recomendado es el raíz.

## Verificaciones reproducibles

Pruebas locales del portal:

```sh
cd nuevo-ticket
npm test
```

Integración aislada: `tests/portal-compose.yml` se combina con el Compose raíz
bajo el proyecto **tickets-portal-check**, usando `.env.example` y
`PLANE_MCP_API_KEY=plane_api_portal_integration_test_only`. No usar ese token en producción.
Se levantan datos/migrator primero; después API, bridge, proxy y formulario.
El overlay elimina dependencias de web/MCP únicamente para esta prueba y publica
el formulario solo en `127.0.0.1:15179` y Plane en `127.0.0.1:13079`.
No usar el overlay en Dokploy.

- `tests/seed_portal.py`: preparar datos en API de prueba; exige
  `PORTAL_TEST_SEED=tickets-portal-check`.
- `node tests/portal-e2e.mjs`: registro sin crear usuario Plane, primer envío con
  PNG, segundo proyecto, autor real, reintento, conflicto de contenido, logout y
  protección de cuenta Plane preexistente.
- `tests/bridge_checks.py`: ejecutar dentro del bridge de prueba con la misma
  variable de guardia; comprueba autorización privada, concurrencia, suspensión
  de membresía y rechazo de proyecto inexistente.
- `tests/portal-browser.cjs`: con Playwright y Chrome, prueba registro/login/logout,
  envío y recuperación de una respuesta perdida después de recargar el navegador.
  `PLAYWRIGHT_MODULE` permite usar una instalación temporal de Playwright.
- `tests/plane-author-browser.cjs`: con web/worker del stack de prueba iniciados,
  comprueba el nombre en Created By en la imagen oficial de la interfaz de Plane.

El despliegue del VPS y el flujo con Cursor no se ejecutan mediante estas pruebas.

### Resultado de esta implementación

Verificado con la imagen backend fijada (la instancia reporta Plane Community
1.4.2), su frontend oficial y Node de la imagen de producción:

- Builds Linux del formulario y bridge correctos, ambos ejecutando sin root.
- Compose de producción y combinación local válidos; 17 servicios en producción.
- Cuatro pruebas automatizadas del portal correctas, también dentro de Node 22.
- Integración con PostgreSQL, Valkey, RabbitMQ, Plane, Caddy, MinIO y Floci correcta:
  registro independiente, dos proyectos, cuenta única, adjuntos y autoría real.
- Pruebas del bridge correctas: autorización, tres reintentos concurrentes que
  producen un solo ticket, suspensión respetada y proyecto inexistente rechazado.
- Navegador Chrome: registro/login/logout, envío, respuesta perdida + recarga +
  reintento sin duplicación, vista móvil y ausencia de errores JavaScript.
- En la interfaz oficial de Plane se comprobó **Created by: María García** y
  la actividad de creación bajo esa misma identidad, sin nombre en la descripción.
- Recreación del contenedor del formulario conservó usuarios y sesiones en el volumen.

Todo se ejecutó en el proyecto Docker aislado `tickets-portal-check`, sin alterar
los datos del stack local existente. No se hizo push ni despliegue al VPS.
