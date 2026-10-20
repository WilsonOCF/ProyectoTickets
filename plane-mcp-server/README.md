# MCP de Plane para Dokploy

Despliegue de un solo contenedor mediante **Dockerfile**, sin Docker Compose.
La imagen final usa Python 3.11 slim y un usuario sin privilegios (UID 10001).
El build copia el servidor oficial 0.3.4 y sus dependencias ya instaladas desde
una imagen fijada por digest; no depende de la etiqueta cambiante `stable`.

Este despliegue ofrece el transporte HTTP con token por peticion. No inicia
OAuth ni SSE, no requiere Redis/Valkey y no guarda sesiones ni datos en disco.
Los tickets se guardan en Plane. El contenedor puede reemplazarse sin perderlos.

## Variables

Configura las variables en Environment de Dokploy; no se copian archivos .env
a la imagen. `.env.example` contiene la lista de configuracion propia.

| Variable | Uso |
| --- | --- |
| `PLANE_BASE_URL` | Obligatoria. URL de Plane accesible desde el servidor, sin `/api/v1`. |
| `PLANE_INTERNAL_BASE_URL` | Opcional. Reemplaza la URL anterior en llamadas API si se define. |
| `HOST` | Direccion de escucha; predeterminado `0.0.0.0`. |
| `PORT` | Puerto interno; predeterminado `8211`, admitido entre 1024 y 65535. |
| `LOG_LEVEL` | Nivel del servidor; predeterminado `info`. |
| `LOG_PAYLOADS` | Predeterminado `false`; evita registrar contenidos en el middleware. |

No se necesitan claves de LLM: este servicio conecta con Plane, no con el modelo.
Tampoco se configura una URL del propio MCP en el servidor: la usa el cliente.
El token de Plane y el workspace se envian desde el cliente en cada peticion,
no como credenciales globales del contenedor.

## Dokploy

1. Conecta el repositorio en una aplicacion y elige build por Dockerfile,
   ruta `./Dockerfile`, contexto la raiz del repositorio.
2. Completa Environment con `.env.example` y la URL real de Plane.
3. Configura el dominio HTTPS apuntando al puerto interno `8211` (o tu `PORT`).
   `EXPOSE 8211` es metadato; si cambias `PORT`, cambia tambien el puerto en Dokploy.
4. No configures volumenes ni servicios Redis/Valkey para esta aplicacion.
5. Despliega. `/healthz` debe responder 200. Esto comprueba el proceso, no la
   disponibilidad de Plane ni la validez del token.
6. Desde el cliente, autentica y lista proyectos para comprobar la integracion real.

Plane debe ser accesible desde el servidor. `localhost` alli apunta al servidor,
no a tu computadora. La URL real y los tokens se completan al desplegar.

## Conexion desde la web

En el backend de la web configura:

```dotenv
MCP_SERVER_URL=https://mcp.example.com/http/api-key/mcp
```

En todas las peticiones MCP envia los encabezados:

```text
Authorization: Bearer <token de Plane>
X-Workspace-slug: <slug del workspace>
```

Usa un cliente MCP compatible con Streamable HTTP. Un navegador haciendo GET
no es una prueba del protocolo. Conserva las credenciales en el backend de la
web. No hay inicio de sesion OAuth en este contenedor.

## Construccion y prueba local

```powershell
docker build -t plane-mcp-dokploy:local .
docker run --rm -d --name plane-mcp-test --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --env-file .env.example -p 127.0.0.1:18211:8211 plane-mcp-dokploy:local
docker exec plane-mcp-test python healthcheck.py
docker logs plane-mcp-test
docker stop plane-mcp-test
```

El dominio example.com es ficticio: sirve para probar el arranque, pero no
para operar sobre Plane. Para una prueba real, usa otro archivo privado con
la URL correcta. No sobrescribas tus archivos privados actuales.
El contenedor admite filesystem de solo lectura; `/tmp` es temporal.

## Archivos anteriores

`docker-compose.yml`, `start-server.cmd` y `crear-ticket-mcp.py` corresponden
al flujo local anterior y no entran en la imagen Dockerfile. No se modifican
tus contenedores existentes. El Compose anterior conserva su configuracion
OAuth/Valkey y no usa el nuevo `.env.example`.

`requirements.txt` corresponde al cliente auxiliar local. El Dockerfile usa
las dependencias exactas de la imagen oficial fijada, sin instalarlas desde
ese archivo. `.dockerignore` solo permite enviar los dos scripts de servidor
y el Dockerfile al build; las credenciales quedan fuera de la imagen.

## Referencia del servidor oficial

https://github.com/makeplane/plane-mcp-server
