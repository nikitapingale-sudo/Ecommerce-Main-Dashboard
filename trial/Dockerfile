# ============================================================
#  Backend API (scripts/api.py) — Trino aggregation + Groq chatbot
#  Builds a small image that runs the always-on API server.
#  Works on Render / Railway / Fly.io / any Docker host / EC2.
#
#  Build:  docker build -t pw-orders-api .
#  Run:    docker run -p 8000:8000 \
#            -e API_ALLOWED_ORIGINS="https://your-app.vercel.app" \
#            -e GROQ_API_KEY="gsk_..." \
#            pw-orders-api
# ============================================================
FROM python:3.12-slim

WORKDIR /app

# Install deps first (better layer caching).
COPY scripts/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Backend code (dbm.py / aggregate.py / api.py).
COPY scripts/ ./scripts/

ENV API_HOST=0.0.0.0 \
    API_PREWARM=true \
    PYTHONUNBUFFERED=1

# Platforms that inject $PORT (Render/Railway) are honored automatically;
# otherwise the server listens on 8000.
EXPOSE 8000

CMD ["python", "-u", "scripts/api.py"]
