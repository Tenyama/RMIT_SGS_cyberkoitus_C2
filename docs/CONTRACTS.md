# ProcureGuard — Contracts & ownership

Types: `shared/types.ts`. Schema: `server/schema.sql`. Design: `docs/DESIGN.md`. Only the orchestrator edits these four.

## Decisions
| # | Decision | Why |
|---|---|---|
| D1 | Web = Vite + React 19 + `@tidecloak/react` (reference-repo layout) in `web/` | Kept from v1 |
| D2 | Server = Node 18 + Hono + better-sqlite3 + jose + vitest@2, `tsx` | Host Node 18.19.1 |
| D3 | Realm = `test1` (already Tide-licensed, IGA on) | `tidewatch` licence setup failed on Tide's ORK network `[measured]` |
| D4 | Agents are TideCloak confidential clients; they call our HTTP API with their own token | Enforcement must not trust in-process callers |
| D5 | Quantities/limits are deterministic; Claude only chooses supplier among offers, writes text, and may *propose* bad things | LLM is never the authority |
| D6 | LLM = `@anthropic-ai/sdk`, model env `LLM_MODEL` default `claude-opus-5-5`, `output_config.effort: "low"`, structured output via `client.messages.parse` + `zodOutputFormat`; `LLM_MODE=off` or missing key → deterministic stub text | Anthropic tokens available; demo must not die without them |
| D7 | Exception approval = IGA CR "GRANT `proc.exception-submit` → agent-planner" opened by `tidewatch-sa`; IGA status `APPROVED`/`COMMITTED` = approved, `DENIED` = rejected | Uses Tide quorum, not an app table |
| D8 | `AUTH_MODE=dev` accepts `X-Dev-Sub` + `X-Dev-Roles` (comma list); agents in dev mode send their role via these headers | Tests/offline |
| D9 | Realm role/grant calls may return **202 or 204 with a CR created**; after any 2xx, look up the newest PENDING CR for that entity to get its id | Measured on `test1` |

## Env (server)
`PORT=4000 TIDECLOAK_URL=http://localhost:8080 REALM=test1 AUTH_MODE=jwt|dev HMAC_KEY DB_PATH=./data/procure.db`
`SA_CLIENT_ID=tidewatch-sa SA_CLIENT_SECRET` · `AGENT_ANALYST_SECRET AGENT_PLANNER_SECRET AGENT_EXCEPTION_SECRET`
`ANTHROPIC_API_KEY LLM_MODEL=claude-opus-5-5 LLM_MODE=on|off API_BASE=http://localhost:4000`
Load with `set -a; . ./.env; set +a` (no dotenv).

## Ownership
| Path | Track |
|---|---|
| `shared/`, `server/schema.sql`, `docs/{DESIGN,CONTRACTS}.md`, root `package.json` | orchestrator |
| `server/src/{index,db,auth,policy,replenish,seed,audit,sse,hmac}.ts`, `server/test/core-*.test.ts` | **P1 core** |
| `server/src/agents/*`, `server/src/llm.ts`, `server/test/agents-*.test.ts` | **P2 agents** |
| `server/src/{iga,governance}.ts`, `server/test/{iga,gov}-*.test.ts`, `web/src/pages/Approver.jsx`, `infra/realm/README.md` | **P3 governance** |
| `web/` except `pages/Approver.jsx` | **P4 web** |
| `README.md`, `docs/DEMO.md` | docs (after merge) |

## Routes (all under `/api`, all JSON, auth on all except `/api/health`)
| Method | Path | Permission | Owner |
|---|---|---|---|
| GET | `/me` | any | P1 |
| GET | `/inventory` | inventory:read | P1 |
| GET | `/suppliers?sku=` | supplier:read | P1 |
| POST | `/po` | po:draft | P1 |
| POST | `/po/:id/submit` | po:submit (+ quorum path) | P1 (calls P3 `openExceptionRequest`) |
| GET | `/po?status=` | po:read | P1 |
| POST | `/po/:id/exception-report` | exception:report | P1 |
| POST | `/agents/run` | agents:run | P1 mounts, P2 implements `runCycle` |
| POST | `/demo/inject` | demo:inject | P1 |
| GET | `/audit` | audit:read | P1 |
| GET | `/stream` | any (`?access_token=` or dev query) | P1 |
| GET | `/change-requests` | APPROVER | P3 |
| GET | `/health` | none | P1 |

## Module seams (compile independently; missing modules are optional imports)
- P1 `policy.ts`: `evaluateSubmit(po, actor: {label, roles}, ctx: {now, dailySpent, supplier, product, recommendation, quorumApproved: boolean}) → {status, checks}` — pure function.
- P1 `sse.ts`: `publish(ev: StreamEvent)`; `audit.ts`: `append(actor, action, target)`, `verify()`.
- P2 `agents/index.ts`: `runCycle(opts: {apiBase, runId, log: (agent, step, message) => void}) → Promise<{summary}>`; `retryApproved(poId)` (planner re-submits with a fresh token).
- P2 `agents/token.ts`: `getAgentToken(name: AgentName) → Promise<{headers: Record<string,string>}>` (jwt: client_credentials; dev: X-Dev headers).
- P3 `iga.ts`: `openExceptionRequest(poId, agentClientId) → {change_request_id}`; `getChangeRequest(id) → ChangeRequest`; `listChangeRequests(status?)`; `registerIgaRoutes(app)`; `IgaError`.
- P3 `governance.ts`: `startGovernance({onApproved(poId), onRejected(poId)})` — polls open CRs every 3 s.
