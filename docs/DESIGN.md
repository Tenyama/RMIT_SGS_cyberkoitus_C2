# ProcureGuard — Design (RFC-002)

| | |
|---|---|
| **Challenge** | RMIT × Tide "UNLOCKED" (C2) — deadline 2026-10-22 18:00 ICT |
| **Replaces** | RFC-001 Tide Watch (see git history, commit 189b2c2) |
| **Tags** | `[measured]` ran it · `[inferred]` from docs/code, not run |

## 1. One-liner
AI agents automate routine building-materials procurement; TideCloak makes their authority **enforceable**: an agent can propose anything, but can only execute what its role allows, and anything bigger needs a human quorum through Tide's IGA.

## 2. Problem
- Manual replenishment (what / how much / when to order) is slow and inconsistent; Rautakesko automated ~90% of order lines (vendor-reported) — the model works.
- An autonomous purchasing agent is a new **god mode**: wrong qty, unapproved supplier, budget overrun, or manipulated input data (prompt injection in a supplier note).
- Today the fix is an approval table inside the same app the agent runs in — the app (or anyone who owns it) can bypass it.

## 3. Solution
| Layer | Does | Trust |
|---|---|---|
| Deterministic replenishment (`replenish.ts`) | Reorder point = demand × lead time + safety stock; order-up-to qty | Trusted math |
| 3 Claude agents | Analyst explains risk · Planner picks supplier + drafts PO · Exception analyst explains blocked POs | **Untrusted** — proposals only |
| Policy engine (`policy.ts`) | Per call: verify token → role → permission → business rules | Enforcer |
| TideCloak (realm `test1`) | Identities for humans **and** agents, roles, IGA quorum for exceptions | Root of authority, no single admin can grant |

## 4. Architecture
```
 Browser (Vite+React, Tide login)            TideCloak test1 (IGA on, attestor=tide)
  buyer1/staff1 · approver1..3 · auditor      ├─ users + roles
        │ Bearer JWT                          ├─ clients: tidewatch-app, tidewatch-sa,
        ▼                                     │           agent-analyst/-planner/-exception
 ┌──────────────── server (Hono :4000) ─────┐ └─ change requests (quorum, enclave-signed)
 │ auth.ts   verify JWT (JWKS) → roles      │◄──── JWKS / client_credentials ────┘
 │ policy.ts role→permission→rules (PEP)    │──── tidewatch-sa: open CR "grant
 │ routes    /api/inventory /po /audit ...  │     proc.exception-submit to agent-planner"
 │ agents/   analyst · planner · exception  │──── HTTP to OUR OWN API with THEIR OWN token
 │   └─ Anthropic SDK (Claude) structured   │
 │ governance.ts poll CR → approved → retry │
 │ SQLite + audit hash-chain · SSE          │
 └──────────────────────────────────────────┘
```
Agents run in-process but **call the HTTP API like any external client**, each with its own TideCloak token — so the policy engine treats them exactly like a compromised external caller would be treated.

## 5. MVP scope (by 17:30)
**In**
- 1 warehouse, 8 SKUs, 4 suppliers (1 unapproved, with an injectable malicious note), seeded.
- Run cycle: Analyst → Planner → policy → executed | blocked | pending_approval → Exception analyst.
- Exception = IGA change request granting `proc.exception-submit` to `agent-planner`; approvers sign in TideCloak; planner re-submits; executes once; auditor sees the chain.
- Dashboard: inventory + reorder points, PO board with policy checks, live agent log (SSE), approvals, audit (hash-chain valid ✓).
- Demo attack: prompt injection in supplier note → agent tries 2,000 bags from unapproved supplier → **blocked**; direct API call with planner token for 80M VND → **pending_approval**, not executed.

**Out**: real ERP/supplier API, forecasting ML, multi-warehouse, auto-revoke of the temporary role (manual CR, stated in limitations), payments.

## 6. Data flow (one cycle)
```
buyer clicks "Run agents" ─► POST /api/agents/run (proc.buyer)
1 Analyst  [token agent-analyst]  GET /api/inventory → recommendations (deterministic)
           Claude → {sku, risk, rationale}[]                       ─► SSE agent.log
2 Planner  [token agent-planner]  GET /api/suppliers?sku → Claude picks {supplier, qty, justification}
           POST /api/po (draft) → POST /api/po/:id/submit
           policy.ts: role ✓ supplier_approved? price ±20%? qty ≤ 3×rec? total ≤ 10M? daily ≤ 30M?
             all ok            → executed (on_order += qty)        ─► SSE po.updated
             hard violation    → blocked
             over 10M / daily  → pending_approval + IGA CR (via tidewatch-sa)
3 Exception [token agent-exception] for blocked/pending → Claude → ExceptionReport → POST exception-report
4 Approvers approve CR in TideCloak (enclave) ─► governance.ts sees APPROVED
           planner fetches a fresh token (now has proc.exception-submit) → re-submit
           policy: quorum ✓ for THIS po_id, exception_used=0 → executed, exception_used=1
```

## 7. How authentication & authorization work
| Who | How they get a token | What the server checks |
|---|---|---|
| Human (buyer, auditor, approver) | Browser → TideCloak login (Tide enclave) → JWT | JWKS signature, `realm_access.roles` |
| Agent (×3) | `client_credentials` with its own client secret | Same JWT checks — agents get **no shortcut** |
| Server → IGA | `tidewatch-sa` client_credentials | Can **open** change requests only; has no `tide-realm-admin`, cannot approve |
| Approver | Approves in TideCloak admin console, signed via Tide enclave | Quorum counted by TideCloak, not by our DB |

Rules: (1) LLM output is data, never authority; (2) every consequential endpoint calls `policy.ts`; (3) the temporary role is only honoured for the PO whose CR was approved, and only once; (4) `AUTH_MODE=dev` (headers `X-Dev-Sub`, `X-Dev-Roles`) exists only for tests/offline demo.

## 8. Measured so far
- Every realm change on `test1` returns `202 {changeRequestId}` and waits for approval `[measured 13:52]`.
- Only one pending CR per entity: a 2nd change → `409 Resolve or deny it before requesting this change` `[measured 13:59]`.
- `tide-realm-admin` can only be granted to users linked to Tide: `400 target user is not linked to the Tide identity provider` `[measured 13:58]`.
- CR threshold on `test1` = 1 `[measured]`; target 2-of-3 after approvers link `[inferred]`.

## 9. Limitations (say them to judges)
- The agent's temporary role stays until a revoke CR is approved; the server enforces single use per PO meanwhile.
- `AUTH_MODE=dev` bypasses Tide; the demo runs in `jwt` mode.
- Approver collusion (≥ quorum) can approve anything.
- Simulated supplier execution; no real money moves.
