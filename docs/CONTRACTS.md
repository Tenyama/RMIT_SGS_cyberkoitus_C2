# Tide Watch — Contracts & overrides

Overrides `docs/DESIGN.md` where they conflict. Types: `shared/types.ts`. Schema: `server/schema.sql`. Only the orchestrator edits these three files.

## Decisions (override DESIGN)
| # | Decision | Why |
|---|---|---|
| D1 | `web/` = Vite + React 19 + `@tidecloak/react` (same layout as the reference repo), not Next.js | Reference login flow already works; no SSR needed |
| D2 | `server/` = Node 18 + Hono + better-sqlite3 + SSE, run with `tsx`, test with `vitest@2` | Host Node is 18.19.1; newer vite/vitest/better-sqlite3 need ≥20/22 |
| D3 | Metrics stack = the single `grafana/otel-lgtm` container already in `docker-compose.yml` | Measured working 12:45 (DESIGN §11.1) |
| D4 | ORK layer = in-process simulator in `server/`; real TideCloak series (`tide_token_issue_*`, `tide_midgard_op_*`, `tide_crypto_*`) read from Prometheus | `tide_*` series do exist on `:9000/metrics` after the first Tide op (measured 12:4x, 33 lines) — DESIGN §11.1 "U2 = không" is outdated |
| D5 | All durations × `TIME_SCALE` (default 1, demo 0.01) | "down→lost 30'" is not demoable |
| D6 | Staff "Open all" = one `doDecrypt([...N])`; beacon sends `count=N`; rule sums `count` | 50 sequential decrypts × 1.5–4 s is too slow for the video |
| D7 | Actor always comes from the verified JWT; server keeps an in-memory `Map<actor_hash, sub>` (not persisted) for propose-revoke | Revoke needs the real user id; persisting `sub` would contradict NFR4 |
| D8 | Realm `accessTokenLifespan` = 60 s and Staff calls `updateToken` before each decrypt | A revoked role stays in an already-issued token until it expires, so "bị chặn" would not show in the demo |
| D9 | `AUTH_MODE=dev` accepts header `X-Dev-Sub` + `X-Dev-Roles: role1,role2` instead of a JWT | Agents/tests can't do Tide enclave login |
| D10 | Dropped: auto bootstrap of the realm, §9.3 drill-down, ML, multi-vantage | Time |

## Ports & env
| Service | Port | Env |
|---|---|---|
| tidecloak | 8080 (OIDC/admin), 9000 (health/metrics) | `KC_BOOTSTRAP_ADMIN_*` |
| lgtm | 3001 (Grafana), 4317/4318 (OTLP), Prometheus internal :9090 | — |
| server | 4000 | `PORT=4000`, `TIDECLOAK_URL=http://localhost:8080`, `REALM=tidewatch`, `CLIENT_ID=tidewatch-app`, `SA_CLIENT_ID=tidewatch-sa`, `SA_CLIENT_SECRET`, `PROM_URL=http://localhost:9090`, `HMAC_KEY`, `DB_PATH=./data/tidewatch.db`, `SIMULATOR=on`, `TIME_SCALE=1`, `AUTH_MODE=jwt\|dev` |
| web | 5137 (vite dev, proxies `/api` → :4000) | `public/tidecloak.json` (downloaded from the admin console, gitignored) |

## Ownership
| Path | Track |
|---|---|
| `shared/`, `server/schema.sql`, `docs/CONTRACTS.md`, root `package.json` | orchestrator |
| `docker-compose.yml`, `infra/`, `server/src/iga.ts`, `web/src/pages/Approver.jsx` | A infra-iga |
| `web/src/lib/tide.js`, `web/src/pages/{Customer,Staff}.jsx`, `web/src/App.jsx` | B web-kyc |
| `server/src/{index,db,auth,rules,alerts,audit,sse,hmac}.ts` | C server-core |
| `server/src/{simulator,metrics,chaos}.ts`, `web/src/pages/{Monitor,Platform}.jsx`, `web/src/lib/stream.js` | D sim-platform |
| `README.md`, `docs/DEMO.md` | docs |

## Routes
| Method | Path | Role | Req → Res (types in `shared/types.ts`) | Owner |
|---|---|---|---|---|
| GET | `/api/me` | any | → `MeRes` | C |
| POST | `/api/kyc` | CUSTOMER | `KycCreateReq` → 201 `KycCreateRes` | C |
| GET | `/api/kyc` | STAFF | `?limit&cursor` → `KycListRes` | C |
| POST | `/api/telemetry/decrypt` | any | `DecryptBeaconReq` → 202 | C |
| GET | `/api/stream` | MONITOR/PLATFORM/APPROVER | SSE `StreamEvent`; JWT via `?access_token=` (EventSource has no headers) | C |
| GET | `/api/alerts` | MONITOR | `?status` → `AlertsRes` | C |
| POST | `/api/alerts/:id/propose-revoke` | MONITOR | → 202 `ProposeRevokeRes` (calls `iga.revokeRole`) | C + A (`iga.ts`) |
| POST | `/api/alerts/:id/dismiss` | MONITOR | `DismissReq` → 200 | C |
| GET | `/api/change-requests` | APPROVER | `?status` → `ChangeRequestsRes` | A |
| GET | `/api/nodes` | PLATFORM/MONITOR | `?key_id` → `NodesRes` | D |
| POST | `/api/chaos` | PLATFORM, `SIMULATOR=on` | `ChaosReq` → 200 `NodesRes` | D |
| GET | `/api/metrics` | none | Prometheus text, `tidewatch_*` + simulated `tide_ork_*` | D |

Approver authorize/deny goes browser → TideCloak IGA directly with the approver's own token (DESIGN §8.1 note); the server never approves.

## Module seams (so tracks compile independently)
- `server/src/iga.ts` exports `revokeRole(sub: string, role: string): Promise<{change_request_id: string}>`, `listChangeRequests(status?: string): Promise<ChangeRequest[]>`; throws `IgaError{code: 'FORBIDDEN'|'CONFLICT'|'QUORUM_NOT_MET'|'ENTITY_VANISHED'|'UNEXPECTED', status}`.
- `server/src/sse.ts` exports `publish(ev: StreamEvent): void`; D's simulator calls it, C owns it.
- `server/src/simulator.ts` exports `getNodes(key_id): NodesRes`, `chaos(req: ChaosReq): NodesRes`, `tick(now): StreamEvent[]`; C's index.ts mounts D's routes via `registerSimRoutes(app)`.
