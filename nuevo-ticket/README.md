# Nuevo Ticket

Formulario web con registro e inicio de sesión propios para enviar incidencias,
mejoras o problemas de clientes a los proyectos disponibles en Plane.

**Flujo vigente:** [PORTAL_USUARIOS.md](../PORTAL_USUARIOS.md). Al enviar el primer
ticket se crea automáticamente la identidad de Plane y sus membresías. El work
item conserva a esa persona como autora en Created By. La contraseña del portal
no se copia a Plane. Los usuarios del portal persisten en el volumen `tickets-users`.

El navegador utiliza HTML, CSS y JavaScript de `public/`. El servidor es
Node.js con Express (`server.js` y `lib/`). Los adjuntos se guardan en Floci,
un emulador de almacenamiento S3, y se intenta adjuntarlos también a Plane.
El análisis con Cursor utiliza Python y es opcional: sin clave o si falla,
se genera una plantilla local.

## Ejecución local

Para el stack integrado, usar los Compose de la raíz y su override local,
según [DOCKER_OPERACION.md](../DOCKER_OPERACION.md). El servicio privado
`plane-ticket-bridge` es obligatorio para enviar tickets. Las instrucciones
siguientes de ejecución directa requieren un bridge ya desplegado y accesible.

Requiere Node.js 22.13 o posterior y Docker con contenedores Linux para Floci.
Las dependencias de Node están en `package.json` y sus versiones resueltas en
`package-lock.json`. Se instalan con `npm ci`.

La configuración privada está en `.env`, que nunca debe subirse. Una instalación
nueva puede copiar `.env.example` a `.env` y completar sus valores.
`docker compose -f docker-compose.floci.yml up -d` inicia solo Floci.
`npm start` inicia la web en `http://127.0.0.1:5179`.
En Windows, `start.cmd` automatiza ese inicio.

Para el análisis opcional se necesita Python 3.10 o posterior y
`pip install -r requirements.txt` en un entorno virtual. En Windows se busca
`.venv-cursor312/Scripts/python.exe`; `CURSOR_PYTHON` permite elegir otro intérprete.
El contenedor instala Python y el SDK automáticamente.

## Archivos para desplegar

**Dokploy del proyecto integrado:** seleccionar el `docker-compose.yml` de la
raíz del repositorio. Incluye el bridge y conserva las redes y routers existentes.
Las instrucciones siguientes describen únicamente el Compose independiente de
esta carpeta; ese modo exige `PLANE_BRIDGE_URL` y su secreto de integración.

Antes solo existía `docker-compose.floci.yml`: no ejecutaba la aplicación.
Ahora `Dockerfile` construye la aplicación con Node y Python, y
`docker-compose.yml` ejecuta la aplicación y Floci juntos. En Dokploy corresponde
un servicio **Compose**, archivo `./docker-compose.yml`, con dominio HTTPS
dirigido al servicio `app`, puerto interno `5179`.
No se publican los puertos de Floci ni se monta el socket de Docker.
El volumen `floci-data` conserva los datos; requiere respaldo propio y no debe
borrarse al actualizar. Floci es un emulador: esta configuración conserva el
almacenamiento que ya usaba el proyecto. Para datos críticos conviene evaluar
un servicio S3 de producción con copias de seguridad.

Plane y su servidor MCP son dependencias externas: este Compose no los instala.
Sus direcciones deben ser accesibles desde los contenedores del servidor.
`localhost` dentro de Docker apunta al mismo contenedor, no a tu computadora
ni a otro servicio. Los valores locales siguen sirviendo para ejecutar sin Docker;
en producción la aplicación rechaza esas direcciones para sus dependencias.

## Variables

| Variables | Uso |
| --- | --- |
| `SESSION_SECRET` | Secreto aleatorio privado de al menos 32 caracteres para firmar sesiones. |
| `PLANE_API_URL` | Dirección de Plane accesible desde el servidor. |
| `PLANE_WEB_URL` | Dirección de Plane que abren los usuarios en su navegador. |
| `PLANE_WORKSPACE_SLUG` | Identificador del espacio de trabajo. |
| `PLANE_MCP_URL`, `PLANE_MCP_API_KEY` | Dirección MCP y token de Plane con permisos para crear tickets y adjuntos. |
| `FLOCI_BUCKET` | Nombre del contenedor de archivos, por defecto `tickets`. |
| `AWS_REGION` | Región del almacenamiento, por defecto `us-east-1`. |
| `FLOCI_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Configuración S3. Compose fija la dirección interna de Floci y sus credenciales ficticias. Para otro S3 hay que adaptar Compose. |
| `CURSOR_API_KEY`, `LLM_MODEL` | Análisis opcional con Cursor; modelo por defecto `auto`, sujeto a disponibilidad en la cuenta. |
| `HOST`, `PORT`, `NODE_ENV`, `CURSOR_PYTHON` | Compose/Docker configuran automáticamente la ejecución en producción. |
| `TEST_BASE_URL`, `TEST_PLANE_EMAIL`, `TEST_PLANE_PASSWORD` | Solo pruebas manuales locales; no se necesitan en Dokploy. |

`LLM_API_KEY` y `CURSOR_MODEL` se admiten como nombres antiguos.
Los valores privados se introducen en Environment de Dokploy. No copiar el
`.env` local completo: contiene direcciones de desarrollo y credenciales de pruebas.
El archivo `.env.example` solo documenta nombres y valores ficticios.

## Revisión de privacidad

La contraseña del script de pruebas se trasladó al `.env` privado. Los
identificadores de proyectos también se conservan allí y se leen mediante variables.
Los scripts ya no imprimen el prefijo de la clave de Cursor. Se quitó el enlace
fijo a localhost del formulario. La ruta de Python se adapta a Windows/Linux.
El endpoint de salud ya no revela nombres de archivos ni direcciones internas.

`.gitignore` excluye `.env` y sus variantes privadas, dependencias instaladas,
entornos Python, cachés, logs, datos, respaldos, certificados y la captura de prueba.
`.dockerignore` limita la construcción a los archivos necesarios: las credenciales
no se copian a la imagen. `.env.example` sí se incluye en GitHub.
La carpeta inicialmente no tenía repositorio Git; no se creó ni publicó uno remoto.

## Comprobación

`/api/live` comprueba que el proceso responde. `/api/health` comprueba además
el acceso al bucket sin listar archivos ni crear datos. Al iniciar se intenta crear
el bucket si no existe. Una respuesta saludable no comprueba el login, los permisos
MCP ni el análisis con Cursor: se necesita probar esas integraciones tras desplegar.
Las sesiones en producción requieren HTTPS y el proxy de Dokploy.
`scripts/e2e_check.py` crea tickets reales y solo debe ejecutarse deliberadamente.

La preparación se comprobó construyendo la imagen y arrancando este Compose con
variables ficticias en contenedores aislados. Respondieron la web y los endpoints
de salud; el bucket fue accesible y el envío sin sesión devolvió 401. Python pudo
importar el SDK y arrancar/cerrar su bridge en Linux, sin llamar a modelos.
Se comprobó que la imagen no incluye `.env` ni el script de pruebas con login, y
que los archivos candidatos a Git no contienen los valores de claves o contraseñas
del `.env` privado. Los contenedores y el volumen de prueba se eliminaron.
Esto no sustituye las comprobaciones con Plane, MCP y Cursor después del despliegue.

Referencias: [Dokploy](https://docs.dokploy.com/docs/core/applications),
[Floci](https://github.com/floci-io/floci),
[Cursor Python SDK](https://cursor.com/docs/sdk/python).

Los proyectos se consultan desde Plane mediante GET /api/proyectos (sesion requerida). Selecciona un proyecto en el formulario; su UUID se envia como project_id y se valida en el workspace configurado.
