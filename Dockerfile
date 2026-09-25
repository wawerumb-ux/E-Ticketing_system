FROM python:3.13-slim

RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY backend/ .
COPY frontend/ /frontend/
COPY scripts/ /app/scripts/

RUN chmod +x /app/docker-entrypoint.sh && \
    mkdir -p /app/uploads && \
    chown -R appuser:appuser /app /frontend

USER appuser

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UPLOAD_FOLDER=/app/uploads

EXPOSE 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
