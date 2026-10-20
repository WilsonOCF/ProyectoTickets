"""Comprueba el proceso local usando el puerto configurado."""

import http.client
import os


def main() -> None:
    host = os.environ["HOST"]
    if host in {"0.0.0.0", "::"}:
        host = "::1" if host == "::" else "127.0.0.1"
    connection = http.client.HTTPConnection(host, int(os.environ["PORT"]), timeout=3)
    try:
        connection.request("GET", "/healthz")
        raise SystemExit(0 if connection.getresponse().status == 200 else 1)
    finally:
        connection.close()


if __name__ == "__main__":
    main()
