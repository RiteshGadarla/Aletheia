FROM python:3.12-alpine
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY sources/generators/log_generator.py .
COPY sources/generators/servers ./servers
USER nobody
ENTRYPOINT ["python", "servers/serve.py"]
