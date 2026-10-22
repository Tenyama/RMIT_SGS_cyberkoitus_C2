# One image: builds the web UI and serves it from the API server (STATIC_DIR).
FROM node:20-slim AS web
WORKDIR /app
COPY shared ./shared
COPY web/package*.json ./web/
RUN npm --prefix web ci
COPY web ./web
# Dev-auth UI identity is baked in at build time (Railway passes service vars as build args)
ARG VITE_DEV_ROLES
RUN npm --prefix web run build

FROM node:20-slim
WORKDIR /app
# better-sqlite3 falls back to a source build if no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY shared ./shared
COPY server/package*.json ./server/
RUN npm --prefix server ci
COPY server ./server
COPY --from=web /app/web/dist ./server/public
WORKDIR /app/server
# No VOLUME line: Railway rejects it; attach a platform volume at /data instead
ENV PORT=4000 STATIC_DIR=public DB_PATH=/data/procureguard.db
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
