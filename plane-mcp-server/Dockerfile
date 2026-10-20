# Reutiliza codigo y dependencias exactas del MCP verificado.
FROM makeplane/plane-mcp-server@sha256:7890d0a6cbbd062311907a5daa8ca612a81fcf101790ea4936e9350d2928ce55 AS upstream

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/upstream \
    HOST=0.0.0.0 \
    PORT=8211 \
    LOG_LEVEL=info \
    LOG_PAYLOADS=false

COPY --from=upstream /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=upstream /app/plane_mcp /opt/upstream/plane_mcp

RUN groupadd --gid 10001 mcp \
    && useradd --uid 10001 --gid mcp --no-create-home --shell /usr/sbin/nologin mcp

WORKDIR /app
COPY server.py healthcheck.py ./
USER 10001:10001

EXPOSE 8211
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "healthcheck.py"]

ENTRYPOINT ["python"]
CMD ["server.py"]
