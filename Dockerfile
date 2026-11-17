# ── Cloider App Engine · Dockerized app demo ─────────────────
FROM node:alpine

LABEL org.opencontainers.image.title="cloider-dockerized-app" \
      org.opencontainers.image.description="Cloider App Engine demo"

ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=1.0.0

WORKDIR /app

# 1) Dependencies first, so this layer is cached between code changes
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 2) App source (includes this Dockerfile, so the page can show it)
COPY . .
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > .build-time

# 3) Drop root privileges: the official image ships a "node" user
USER node

EXPOSE 3000

# 4) Tell the runtime whether the app is actually serving
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

CMD ["node", "server.js"]
