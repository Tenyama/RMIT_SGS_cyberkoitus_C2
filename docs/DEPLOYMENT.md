# Deployment

ProcureGuard can be hosted in two ways. Both run the demo in **dev-auth mode** (no TideCloak needed); real Tide mode is local-only, see the README.

## Option 1: Vercel (web + API as two services)

[vercel.json](../vercel.json) defines two services behind one domain:

| Service | Root | Built from | Routed for |
|---|---|---|---|
| `web` | `web/` | Vite framework preset | everything except `/api/*` |
| `api` | `./` (repo root, because the server imports `shared/`) | [Dockerfile.vercel](../Dockerfile.vercel) | `/api/*` |

```bash
npm i -g vercel
vercel link                 # once; creates the gitignored .vercel/ folder
vercel deploy --prod --yes
```

Project environment variables (set with `vercel env add <NAME> production`):

| Name | Purpose |
|---|---|
| `AUTH_MODE` | auth mode for the API (`dev` for the hosted demo) |
| `SIM_QUORUM` | `1` enables the **Simulate quorum approval (dev)** button |
| `HMAC_KEY` | key used to pseudonymise actor IDs (HMAC-SHA256 of the token subject); falls back to a dev key if unset |
| `VITE_DEV_ROLES` | roles the web UI sends as dev headers (baked in at build time) |

Verify after deploying:

```bash
curl https://<your-domain>/api/health     # {"ok":true}
```

If Deployment Protection is on, use `vercel curl <url>` or open the page while logged in to Vercel.

**Caveat:** the API instance filesystem is not durable. The SQLite DB lives at `/tmp/procureguard.db` and is reseeded whenever the instance scales down (about 5 minutes idle).

## Option 2: Single container (Railway or any Docker host)

The root [Dockerfile](../Dockerfile) builds the web UI and serves it from the API server.

```bash
docker build --build-arg VITE_DEV_ROLES=proc.buyer,proc.auditor -t procureguard .
docker run -p 4000:4000 -e AUTH_MODE=dev -e SIM_QUORUM=1 -v pgdata:/data procureguard
```

- `STATIC_DIR=public` makes [server/src/index.ts](../server/src/index.ts) serve the built UI, with an SPA fallback to `index.html`.
- Mount a volume at `/data` to persist `DB_PATH=/data/procureguard.db`. The image has no `VOLUME` line because Railway rejects it.
- `VITE_DEV_ROLES` is a build argument, not a runtime variable.

## Ignore files

`.dockerignore` and `.vercelignore` keep `node_modules`, `dist`, local DBs, `.env*` and the large `demo-bundle/` and `procureguard-bundle-lite/` folders out of uploads. `.vercel` and `.env*` are gitignored.
