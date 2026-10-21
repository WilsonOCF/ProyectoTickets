# Local y Dokploy

## Local

Copiar `.env.example` a `.env` solo en instalaciones nuevas. No sobrescribir
credenciales de una base existente. En Windows `COMPOSE_FILE` separa archivos
con `;`; en Linux usar `:`. El ejemplo selecciona el override local y conserva
el proyecto `generador-tickets-integrado`. Si ya existen datos con otro nombre
de proyecto, conservar ese nombre.

```sh
docker compose config --quiet
docker compose down
docker compose up -d --build
docker compose ps -a
```

No usar `down -v`: los volumenes contienen los datos. Plane queda en
http://localhost:3000 y el formulario en http://localhost:5179. El override
crea una red de entrada local propia; no necesita instalar Dokploy ni Traefik.
El migrator debe terminar en `Exited (0)`; los otros 15 servicios deben seguir
ejecutandose. El token de ejemplo solo permite arrancar: emitir un token real
en la instancia Plane para usar las funciones del formulario.

## Produccion

Seleccionar unicamente `docker-compose.yml` en Dokploy. No copiar las variables
locales `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME` ni las URLs HTTP del ejemplo.
Configurar los dos dominios y los secretos propios indicados en `.env.example`;
los defaults de secretos son exclusivamente de desarrollo. Los dominios deben
ser distintos, sin esquema ni ruta. Las URLs se derivan con HTTPS por defecto.
La red externa `dokploy-network` debe existir y contener a Traefik.

Se mantienen los puertos internos explicitos 80 (proxy) y 5179 (formulario),
con `traefik.docker.network=dokploy-network`. Web y API permanecen en
`tickets-net`, compartida con el proxy. `internal: true` permite comunicacion
entre miembros; no es, por si solo, causa de un timeout entre ellos.
No registrar los mismos hosts simultaneamente con routers manuales y Domains.

## Diagnostico del 502

El log `dial tcp ...:3000: i/o timeout` situa el fallo entre Caddy y web:
hubo resolucion DNS pero no se completo la conexion TCP. No demuestra un fallo
de TLS, un puerto equivocado ni ausencia de `dokploy-network`.
La imagen web fijada escucha en `0.0.0.0:3000` mediante nginx. El Compose
versionado ya comparte la red privada entre proxy, web y api.

El cambio espera la salud de web, space, admin y api antes de iniciar Caddy;
su nuevo healthcheck comprueba web y api desde la red del propio proxy, ademas
de la ruta HTTP de Caddy. Esto detecta fallos de comunicacion que un healthcheck
en localhost de web no detectaria. No sustituye la inspeccion del VPS.

En el directorio del despliegue del VPS, usando su mismo proyecto y entorno:

```sh
docker compose ps -a
docker compose exec proxy wget -S -O /dev/null -T 5 http://web:3000/
docker compose exec proxy wget -S -O /dev/null -T 5 http://api:8000/api/instances/
docker compose exec web curl -fsS http://127.0.0.1:3000/ -o /dev/null
docker inspect --format '{{json .NetworkSettings.Networks}}' "$(docker compose ps -q proxy)" "$(docker compose ps -q web)"
docker network inspect dokploy-network
```

Comparar la IP que resuelve Caddy con la IP de web en la red privada. Si difieren,
revisar aliases duplicados y el Compose efectivo generado por Dokploy. Si
coinciden y localhost responde, revisar aislamiento/firewall del host y endpoints
Docker. No hay acceso al VPS en esta verificacion: la causa precisa del timeout
remoto y su resolucion definitiva quedan pendientes de estas comprobaciones.

Referencias: [redes y labels en Dokploy](https://docs.dokploy.com/docs/core/docker-compose/example)
y [seleccion de red de Traefik](https://doc.traefik.io/traefik/v2.10/routing/providers/docker/).
