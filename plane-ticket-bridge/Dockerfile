# Must match api/migrator: this integration uses this exact Plane model/serializer API.
FROM makeplane/plane-backend@sha256:90032ce088708889b60c00d491897916f4deb882facda27db59fd10fb68729ef
USER root
RUN mkdir -p /bridge && chown 10001:10001 /bridge /code/plane/logs
COPY --chown=10001:10001 bridge.py /bridge/bridge.py
ENV PYTHONPATH=/code:/bridge PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8220
ENTRYPOINT []
CMD ["gunicorn", "--chdir", "/bridge", "--bind", "0.0.0.0:8220", "--workers", "2", "--timeout", "90", "--access-logfile", "/dev/null", "bridge:application"]
