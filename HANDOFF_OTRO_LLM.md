# Traspaso para continuar con otro LLM — 22 octubre 2026

## Respuesta inmediata sobre los contenedores y datos

Se levantó **un segundo stack Docker aislado** para probar el cambio. No se
reemplazó ni se borró el stack anterior.

| Entorno | Proyecto Compose | Plane | Tickets | Volumen PostgreSQL |
| --- | --- | --- | --- | --- |
| Anterior, datos del usuario | `generador-tickets-integrado` | `http://localhost:3000` | `http://localhost:5179` | `generador-tickets-integrado_pgdata` |
| Prueba aislada nueva | `tickets-portal-check` | `http://localhost:13079` | `http://localhost:15179` | `tickets-portal-check_pgdata` |

Los dos Postgres son contenedores y volúmenes distintos:

```text
generador-tickets-integrado-plane-db-1
  -> generador-tickets-integrado_pgdata:/var/lib/postgresql/data

tickets-portal-check-plane-db-1
  -> tickets-portal-check_pgdata:/var/lib/postgresql/data
```

Conteos observados al cerrar esta sesión:

```text
Stack anterior: 12 usuarios, 6 workspaces, 9 proyectos, 45 tickets.
Stack prueba:    8 usuarios, 1 workspace, 2 proyectos, 8 tickets.
```

### God Mode en ambos entornos

- En el stack anterior, `wilson.carrasco@gmail.com` continúa registrado como
  `InstanceAdmin` con rol 20. Ese es el administrador de God Mode.
- En `tickets-portal-check` no hay registros en `InstanceAdmin`: ninguna cuenta
  tiene God Mode. `portal-owner@example.test` se creó únicamente como propietario
  del workspace `crs` y Workspace Admin (rol 20) para navegar el Plane de prueba.
  No es superusuario, staff ni administrador de la instancia.
- Los usuarios creados automáticamente por el portal tampoco reciben God Mode:
  obtienen Guest (5) en workspace y Member (15) en los proyectos donde reportan.

No se ejecutó `down -v`, no se eliminaron volúmenes y no se restauró ninguna
base encima de otra. Los usuarios María de las pruebas viven únicamente en la
base `tickets-portal-check_pgdata`.

El stack anterior está activo. Su formulario de `localhost:5179` todavía usa la
imagen anterior, porque los cambios nuevos no se aplicaron sobre ese contenedor.
Por eso hoy se puede revisar el Plane anterior en `localhost:3000`, pero el flujo
nuevo de registro propio se prueba en `localhost:15179`.

Sí se puede probar el código nuevo con los datos anteriores. Para hacerlo hay que
reconstruir el stack `generador-tickets-integrado` con el Compose modificado. Eso
conserva sus volúmenes y datos, añade `plane-ticket-bridge` y crea un volumen nuevo
`generador-tickets-integrado_tickets-users` para las cuentas del portal. El primer
envío real creará una identidad y membresías nuevas dentro del Plane anterior.
Esta aplicación del cambio al stack real **todavía no se ejecutó**.

## Efecto esperado al desplegar en producción

Si Dokploy redespliega usando el **mismo proyecto Compose y los mismos named
volumes**, no inicializa una base nueva ni reemplaza los datos existentes:

- Postgres, MinIO, Floci, Valkey y RabbitMQ vuelven a montar sus volúmenes actuales.
- Usuarios, workspaces, proyectos, tickets y el `InstanceAdmin` actual permanecen.
- El migrator vuelve a ejecutar el proceso normal de migraciones; las ya aplicadas
  quedan registradas y no se repiten destructivamente.
- Aparece el servicio privado `plane-ticket-bridge` y un volumen nuevo
  `tickets-users` inicialmente vacío para las cuentas propias del portal.
- No se importan al portal los usuarios actuales de Plane. Una persona se registra
  en el portal y, en su primer envío, se crea/vincula su identidad según el flujo nuevo.
- Cada envío nuevo sí modifica la base Plane de forma intencional: puede añadir un
  usuario, una membresía y el ticket. No modifica el administrador de God Mode.

La condición crítica es que Dokploy conserve el nombre del proyecto Compose y los
volúmenes existentes. Si se crea otra aplicación/Compose, se cambia el nombre del
proyecto o se generan volúmenes nuevos, se verá una instancia vacía aunque los datos
anteriores todavía existan en los volúmenes viejos. Antes del despliegue real se debe:

1. Confirmar el nombre actual del proyecto Compose y los mounts efectivos del VPS.
2. Hacer backup consistente de Postgres y almacenes de archivos.
3. Conservar exactamente las contraseñas/secretos que inicializaron los volúmenes.
4. Revisar el Compose efectivo de Dokploy y verificar que `pgdata`, `uploads`,
   `floci-data`, `redisdata` y `rabbitmq_data` resuelven a los volúmenes actuales.
5. Desplegar sin `down -v` y comprobar God Mode, conteos, login y un ticket controlado.

Por tanto, el código está diseñado para una actualización sobre los datos actuales,
pero la preservación en producción depende de la identidad de proyecto/volúmenes
que Dokploy use realmente. Esa configuración remota no se inspeccionó en esta sesión.

No confundir «recrear contenedores» con «borrar datos»: `docker compose up -d
--build` puede recrear servicios conservando named volumes. `docker compose down
-v` sí elimina datos y no debe usarse.

## Objetivo solicitado

Separar el acceso al formulario de Plane:

1. El portal de tickets tiene registro e inicio de sesión propios.
2. Registrarse no crea todavía una cuenta Plane.
3. Al enviar el primer ticket, se crea automáticamente una identidad Plane con
   nombre/correo del portal y contraseña inutilizable.
4. Se incorpora como Guest al workspace y Member al proyecto seleccionado.
5. El work item se crea bajo esa identidad y muestra su nombre en `Created By`.
6. El usuario nunca necesita abrir Plane ni conocer esa operación.
7. El nombre deja de incluirse como texto automático dentro de la descripción.

## Implementación realizada

### Portal Node

- `nuevo-ticket/lib/portal-store.js`: SQLite, usuarios, sesiones revocables,
  intentos, idempotencia y vínculo con ID de Plane.
- Contraseñas con scrypt y sal aleatoria; Plane no recibe esa contraseña.
- `nuevo-ticket/lib/portal-auth.js`: registro/login/logout propios, validaciones,
  límites de intentos y protección de mutaciones con `X-Tickets-Request`.
- Cookie `nt_portal_session`, firmada, HttpOnly, SameSite=Lax, Secure en HTTPS.
- `nuevo-ticket/lib/plane-bridge.js`: cliente del bridge privado.
- `nuevo-ticket/server.js`: usa `req.portalUser`, valida entradas/proyecto,
  protege reintentos y crea el ticket vía bridge. MCP queda para otros usos.
- `nuevo-ticket/lib/llm.js`: ya no añade «Reportado por» al HTML ni al prompt.
- `nuevo-ticket/public/index.html` y `app.js`: UI registro/login y envío sin
  referencias internas a Plane; conserva la clave de reintento en sessionStorage.
- `nuevo-ticket/public/styles.css`: estilos correctos para email/password.

### Integración Plane

- Nuevo servicio privado `plane-ticket-bridge/`.
- Su Dockerfile deriva del mismo digest de `makeplane/plane-backend` que API y
  migrator, por lo que usa modelos/serializer de esa versión fijada.
- Solo está en `tickets-net`, sin puerto host, sin dominio y con Traefik apagado.
- Autenticación Bearer compartida con el backend de tickets.
- Transacción PostgreSQL para identidad, perfil, membresías y work item.
- Bloqueos advisory más `external_id` evitan duplicados concurrentes/reintentos.
- No acepta un Plane user ID desde el navegador: resuelve la identidad por el UUID
  autenticado del portal y un username interno `tickets_<UUID>`.
- No toma control de un correo ya existente en Plane. Devuelve conflicto 409 y
  exige vinculación administrativa manual futura.
- No reactiva membresías suspendidas/eliminadas.
- El serializer se ejecuta con `crum.impersonate(user)`, por lo que `created_by`
  es el usuario real. La actividad de creación también usa ese actor.

### Compose y persistencia

- El Compose raíz pasó de 16 a 17 servicios al añadir `plane-ticket-bridge`.
- Nuevo volumen `tickets-users:/app/data` para `portal.sqlite`.
- El Dockerfile prepara `/app/data` para el usuario Node no-root.
- Variables:
  - `TICKETS_REGISTRATION_ENABLED=true` por defecto en desarrollo.
  - `PLANE_BRIDGE_URL=http://plane-ticket-bridge:8220`, configurada por Compose.
  - `TICKETS_BRIDGE_SECRET`, opcional; si falta usa `SESSION_SECRET`.
- Redes, routers Traefik, dominios, servicios y volúmenes anteriores se conservaron.
- `PLANE_MCP_API_KEY` sigue usándose para listar proyectos y adjuntar archivos.
- Los documentos antiguos tienen una advertencia que remite a
  `PORTAL_USUARIOS.md`, documento técnico vigente del nuevo flujo.

## Resultado comprobado

Se probó contra un stack completo aislado con la imagen Plane Community fijada
(la instancia reportó 1.4.2):

- Registro/login/logout independientes de Plane.
- Registrarse no crea una identidad Plane.
- Primer envío crea identidad, workspace Guest, proyecto Member y work item.
- Segundo proyecto reutiliza la identidad y añade la membresía necesaria.
- PNG cargado como adjunto nativo de Plane.
- Tres peticiones concurrentes producen un solo ticket.
- Repetir el envío devuelve el mismo ticket.
- Reutilizar la clave con contenido diferente devuelve 409.
- Una respuesta perdida después del commit, seguida de recarga/reintento, recupera
  el mismo ticket sin duplicarlo.
- Cookie anterior al logout no recupera la sesión.
- Un correo preexistente en Plane no se modifica ni se apropia.
- Suspender la membresía impide nuevos envíos y no se revierte automáticamente.
- Proyecto inexistente revierte la creación de identidad.
- UI de escritorio y móvil sin errores JavaScript.
- Interfaz oficial de Plane mostró **Created by: María García** y en Activity:
  **María García created the work item**.
- La descripción no contiene el correo ni «Reportado por».
- Recrear el contenedor de tickets conservó cuentas/sesiones del portal.
- `npm test`: 4/4 correctas, también dentro de la imagen Node 22.
- Builds Linux de `floci-tickets` y `plane-ticket-bridge`: correctos.
- `docker compose config --quiet`: correcto para producción y local.
- `git diff --check`: correcto; solo avisos de normalización LF/CRLF.

Pruebas y overlay están en `tests/`. `PORTAL_USUARIOS.md` explica cómo repetirlas.

## Estado Git y acciones externas

- Los cambios están en el working tree, **sin commit, sin push y sin despliegue en
  Dokploy**.
- `deploy-dokploy.mjs` ya estaba sin seguimiento antes de esta tarea. No se ejecutó
  ni se modificó; no asumir que forma parte del cambio.
- `CONTEXTO_ACTUAL.md` también estaba creado en la sesión anterior y sigue sin
  seguimiento.
- Los contenedores `tickets-portal-check-*` y sus volúmenes siguen activos para
  inspección. No eliminarlos hasta que el usuario termine de revisar, salvo petición.
- El stack real `generador-tickets-integrado-*` sigue activo y no fue reconstruido.

## Riesgos y decisiones pendientes

1. El registro abierto no verifica el correo y no ofrece recuperación de contraseña.
   Es apropiado para la prueba solicitada, pero antes de exposición pública debe
   añadirse verificación/recuperación o integrar identidad de la página principal.
2. Guest en workspace + Member en proyecto es una membresía real. Si alguien
   obtuviera acceso Plane por otro mecanismo, Member puede ver/editar según Plane;
   no es un rol de «solo enviar». No se entrega contraseña Plane al usuario.
3. SQLite supone una sola réplica del formulario y volumen local persistente. Si
   se escala a varias réplicas/nodos, mover usuarios/sesiones/idempotencia a Postgres.
4. Los adjuntos se suben después de crear el ticket. Un fallo devuelve advertencia;
   no duplica el work item. La autoría del adjunto sigue siendo la API key global,
   aunque la autoría del ticket y su actividad sí es la persona.
5. Los eventos se envían después del commit. Si RabbitMQ falla, el ticket se conserva
   y se registra el error; todavía no existe una outbox para reintentar el evento.
6. Al actualizar Plane, actualizar/probar conjuntamente imágenes de backend,
   migrator, workers y bridge, porque el bridge usa interfaces Python fijadas.
7. Falta una herramienta administrativa segura para vincular un usuario del portal
   con una cuenta Plane que ya existía con el mismo correo.

## Próximo paso recomendado

Con el usuario presente, decidir entre:

- Seguir revisando en el stack aislado (`15179` / `13079`).
- Aplicar el código nuevo al stack local con datos anteriores mediante rebuild sin
  `-v`, verificar backup/volúmenes primero y luego ejecutar un ticket de prueba.
- Tras esa validación, revisar diff, crear commit, push y permitir que el webhook
  de Dokploy redespliegue. Ninguna de estas acciones externas se realizó todavía.

No borrar volúmenes, no ejecutar `down -v` y no mezclar el overlay
`tests/portal-compose.yml` con Dokploy.
