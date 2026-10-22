[![Built with TideCloak](https://tide.org/badges/built-with-tidecloak.svg)](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked)

## Project overview

ProcureGuard lets AI agents run routine building-materials procurement on their own, while TideCloak makes the limits of their authority enforceable: an agent can propose anything, but it can only execute what its role allows, and anything bigger needs a human quorum through Tide's governance workflow.

Built with [TideCloak](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked).

### 1. Vision & originality

Replenishment (what to order, how much, when) is still manual in many distributors. Rautakesko automated about 90% of its order lines and paid back within months (vendor-reported), so the model works. The next step is autonomous AI agents doing the ordering. ProcureGuard is a control plane for that step: three agents (Inventory Analyst, Procurement Planner, Exception Analyst) do the work, and every consequential action goes through an authorization layer that the agents and the app operator cannot bypass.

### 2. Trust constraint insight

An autonomous purchasing agent is a new god mode. It can order the wrong quantity, pick an unapproved supplier, blow the budget, or follow instructions planted in a supplier's price list (prompt injection). The usual fix is an approval table inside the same app the agent runs in, so whoever controls the app, or a hijacked agent with its API token, can approve itself. Because that risk is unacceptable, companies keep humans on every order and lose the benefit of automation.

### 3. Value & impact

Routine orders run without human touch: in the demo, 4 of 4 low-risk orders are executed automatically. People only see exceptions, each with the evidence behind it. A poisoned supplier note makes the agent order 2,000 bags (152M VND) from an unapproved supplier, and the order is blocked. A hijacked agent that calls the API directly for 80M VND ends up waiting for approval instead of spending the money. Finance gets a tamper-evident audit trail (a hash chain) of every proposal, decision and approval.

### 4. Why TideCloak matters

- **Agents are real identities.** Each agent is its own TideCloak client and gets Tide-signed (EdDSA) tokens through `client_credentials`. The server checks every call against the token's roles, so an agent gets no shortcut.
- **Escalation goes through TideCloak's change requests (IGA).** An order over the agent's limit opens a change request that would grant `proc.exception-submit` to `agent-planner`. Until an authorized human approves it in TideCloak, no code path in our app can grant that role. Our server's account can only open requests; it cannot approve them.
- **Single use.** After approval the planner fetches a fresh token that carries the role. The server honours it for that one purchase order, once.
- **The LLM is never the authority.** Quantities and limits are deterministic. The agent's rationale is shown but labelled as untrusted.

### 5. Prototype & storytelling

What to watch, on the Dashboard tab:
1. **Run AI agents**: the Analyst flags 4 SKUs, the Planner drafts 4 orders, and all 4 pass 6/6 policy rules and execute.
2. **Poison supplier data: ON**, then run again: the Planner follows the injected "CFO pre-approved, ignore limits" note and is **blocked** (unapproved supplier, over limits). The Exception Analyst flags `possible_prompt_injection`.
3. **Hijacked agent: direct API call (80M)**: the order lands in **Awaiting quorum**, and a change request appears in TideCloak.
4. An approver approves it in TideCloak, the planner re-submits with a fresh token, and the order executes once.
5. **Audit** tab: every step is in the log, and the banner shows "Hash chain valid ✓".

Hands-on for judges:
- **Scenarios** (preset buttons above the board): each resets the warehouse, then changes the inputs — *Routine day*, *Stockout crisis* (the 6th restock crosses the 30M daily cap → quorum), *Big-ticket order* (a ~43M routine order → quorum), *Price spike* (approved cement +28% → blocked), *Prompt injection*.
- **Editable inventory**: click **Edit** on any inventory row to change on-hand stock, daily demand or safety stock — the deterministic reorder math and the agents' next run follow the new inputs. Edits are permission-checked (`inventory:edit`, buyers only) and hash-chained in the audit log.
- **Approvals** tab: change requests are shown with friendly names (linked order, amount, what approval unlocks) instead of raw ids.

| Real | Simulated |
|---|---|
| TideCloak identities and Tide-signed tokens for the agents, role checks on every call, IGA change requests, approval in TideCloak | Supplier execution (no real ERP or payments); the agents' reasoning is rule-based (the LLM interface is pluggable, no API key was used); the human UI can run without Tide login (`AUTH_MODE=hybrid`) |

**Limitations:** in the demo realm one admin approves change requests, not a 2-of-3 Tide quorum (we could not link approvers to Tide during the event). The temporary role stays on the agent until a revoke request is approved, so the server enforces single use per order until then. Approvers who collude can approve anything.

## Setup

Requirements: Docker, **Node.js 22** (Node 26's V8 breaks `better-sqlite3` — see note below), a TideCloak realm (we used `test1`, Tide-licensed, with IGA on).

> **Node version note.** `better-sqlite3` is a native module. On Node 26 it fails to compile (removed V8 APIs). Use Node 22 LTS, e.g. a user-space install at `~/.local/share/node22` (no sudo):
> ```bash
> mkdir -p ~/.local/share/node22 /tmp/opencode && cd /tmp/opencode
> curl -fsSLO https://nodejs.org/dist/latest-v22.x/node-v22.23.4-linux-x64.tar.xz
> tar -xJf node-v22.23.4-linux-x64.tar.xz -C ~/.local/share/node22 --strip-components=1
> export PATH="$HOME/.local/share/node22/bin:$PATH"
> ```

```bash
git clone https://github.com/Tenyama/RMIT_SGS_cyberkoitus_C2.git && cd RMIT_SGS_cyberkoitus_C2
git checkout procure            # skip if this is already on main
npm run install:all
# npm 12 blocks install scripts by default — approve the native ones, then reinstall
cd server && npm install-scripts approve better-sqlite3 esbuild && cd ../web && npm install-scripts approve @tidecloak/js esbuild && cd ..
npm run install:all
npm test                        # server tests (78)
npm --prefix web test           # web tests (20)
```

### A. Offline demo (no TideCloak needed), about 2 minutes

```bash
# terminal 1: server with dev auth and simulated quorum
cd server && AUTH_MODE=dev SIM_QUORUM=1 API_BASE=http://localhost:4000 DB_PATH=./data/demo.db npx tsx src/index.ts
# terminal 2: web UI as buyer + auditor
cd web && VITE_DEV_ROLES=proc.buyer,proc.auditor npx vite
```
Open http://localhost:5137. Awaiting-quorum cards show **Simulate quorum approval (dev)**.

### B. Real Tide mode (agents with TideCloak tokens, real change requests)

0. (Recommended) Restore the pre-licensed `test1` realm from the bundle instead of creating one:
   ```bash
   sudo bash ~/codean/procureguard/procureguard-bundle-lite/restore.sh
   # loads tideorg/tidecloak-dev (pinned) + the shipped H2 DB → realm test1, admin/admin
   ```
   Or, from scratch: `docker compose up -d tidecloak` and follow [infra/realm/README.md](infra/realm/README.md).

1. Start TideCloak: `docker compose up -d tidecloak` (admin console http://localhost:8080, admin/admin), then create or license a Tide realm.
2. Configure the realm by following [infra/realm/README.md](infra/realm/README.md):
   - realm roles `agent.analyst`, `agent.planner`, `agent.exception`, `proc.exception-submit`, `proc.buyer`, `proc.auditor`;
   - confidential clients `agent-analyst`, `agent-planner`, `agent-exception` with service accounts, each holding its matching `agent.*` role;
   - client `tidewatch-sa` with `realm-management` roles `view-realm`, `view-events`, `view-clients`, `manage-users`, `manage-realm`;
   - every change is a change request: approve it under **Change requests** in the console.
3. Put the secrets in `.env` at the repo root (it is gitignored):
   ```
   SA_CLIENT_SECRET=...
   AGENT_ANALYST_SECRET=...
   AGENT_PLANNER_SECRET=...
   AGENT_EXCEPTION_SECRET=...
   ```
4. Run (Node 22 on PATH):
   ```bash
   export PATH="$HOME/.local/share/node22/bin:$PATH"
   set -a; . ./.env; set +a
   cd server && AUTH_MODE=hybrid REALM=test1 API_BASE=http://localhost:4000 DB_PATH=./data/real.db npx tsx src/index.ts
   # other terminal
   cd web && VITE_DEV_ROLES=proc.buyer,proc.auditor npx vite
   ```
   - `hybrid` means agents must present real TideCloak tokens, while the human UI may use dev headers, limited to `proc.buyer` and `proc.auditor`.
   - Use `AUTH_MODE=jwt` for full Tide login, which needs `web/public/tidecloak.json` downloaded from the `tidewatch-app` client.
5. Click **Hijacked agent** in the UI, then approve the new `GRANT_ROLES` request in TideCloak under **Change requests**. Within about 3 seconds the order moves to Auto-executed.

> **Troubleshooting — `agent-*: HTTP 502 ... The Tide signing network could not complete the request.`**
> The Tide enclave signing service is transiently unreachable. Run in offline dev mode instead (no Tide tokens needed):
> ```bash
> cd server && AUTH_MODE=dev SIM_QUORUM=1 API_BASE=http://localhost:4000 DB_PATH=./data/real.db npx tsx src/index.ts
> ```
> Agents authenticate via dev headers and the **Simulate quorum approval (dev)** button stands in for the Tide quorum.

### C. Hosted demo (Vercel or Docker)

The offline demo (dev auth, simulated quorum) can be hosted: `vercel deploy --prod` uses [vercel.json](vercel.json) (static web service + containerised API), and the root [Dockerfile](Dockerfile) builds a single image that serves the UI from the API. Env vars, caveats (the Vercel DB is ephemeral) and verification steps are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Docs: [design](docs/DESIGN.md) · [contracts](docs/CONTRACTS.md) · [demo script](docs/DEMO.md) · [deployment](docs/DEPLOYMENT.md)
