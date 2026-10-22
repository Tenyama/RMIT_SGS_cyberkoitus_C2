# Realm `test1` — ProcureGuard identity & governance

Realm `test1` on the local TideCloak (<http://localhost:8080>, master admin `admin` / `admin`) is
Tide-licensed with **IGA ON** (attestor = tide) — CONTRACTS D3. Everything below already exists or is
done by a human in the admin console; the app never creates realm objects.

Tags: `[measured]` = probed on test1 2026-10-22; `[inferred]` = from docs/code, not run.

## 1. Who holds what
| Principal | Kind | Holds | Purpose |
|---|---|---|---|
| `agent-analyst` | confidential client, service account | realm role `agent.analyst` | reads inventory + offers |
| `agent-planner` | confidential client, service account | realm role `agent.planner` (+ `proc.exception-submit` **only** while an approved exception CR is in force) | drafts / submits POs |
| `agent-exception` | confidential client, service account | realm role `agent.exception` | writes exception reports |
| `staff1` | user | `proc.buyer` | runs agents, sees PO board |
| `monitor1` | user | `proc.auditor` | audit chain |
| `approver1`, `approver2`, `approver3` | users | `realm-management` → `tide-realm-admin` (after each links their Tide account) | sign change requests in TideCloak |
| `tidewatch-sa` | confidential client, service account | `realm-management` → `view-realm`, `view-events`, `manage-users`, `manage-realm` | server → Admin/IGA API: **opens and reads** CRs, never approves |
| `tidewatch-app` | public client | — | browser login for the web app |

- `tide-realm-admin` can only be granted to a user linked to Tide: otherwise `400 target user is not linked to the Tide identity provider` `[measured]`.
- `tidewatch-sa` must **not** get `tide-realm-admin`; without `manage-realm` the IGA list returns 403 `[measured]`.
- Status now: `tidewatch-sa` gets a token (200) but `GET /iga/change-requests` → 403 (0 PENDING CRs at 14:25, so its realm-management roles are not assigned/approved yet) `[measured 14:25]`.

## 2. IGA rules the app relies on
- Every realm change (role grant, client edit, …) returns **202 `{changeRequestId}`** or sometimes **204**, and only takes effect after approval (D9) `[measured]`.
- **One pending CR per entity**: a 2nd change to the same user/client → `409 Resolve or deny it before requesting this change` `[measured]`. So an agent can have only one open exception at a time.
- Statuses: `PENDING` → `APPROVED` (change applied) / `DENIED`. `GET /iga/change-requests` **without** `?status=` returns `[]`; always pass one `[measured]`.
- CR fields: `id, realmId, entityType, entityId, actionType, rows[{USER_ID, ROLE_ID}], status, createdAt, resolvedAt, authorizationCount, authorizers[{username,timestamp}], readyToCommit, threshold, requiredApproverRoles, scopeMode, dependsOn, blocked` `[measured]`. Threshold on test1 = 1 `[measured]`.

## 3. Exception flow (D7)
1. Planner submits a PO over its authority → server (`server/src/iga.ts` `openExceptionRequest`) POSTs
   `proc.exception-submit` to `agent-planner`'s service-account user → CR `GRANT_ROLES` opens.
2. Approver opens <http://localhost:8080/admin/master/console/#/test1> → **Change requests** → reviews → approves with Tide enclave.
3. `server/src/governance.ts` polls every 3 s, sees `APPROVED`, planner re-submits with a fresh token, PO executes once.
4. **Manual revoke (limitation):** the role stays on `agent-planner` until a human removes it:
   Users → filter service-account `service-account-agent-planner` → Role mapping → unassign `proc.exception-submit`
   → approve the resulting CR. Until then a new exception request fails with `ROLE_STILL_GRANTED`
   (and the server honours the role only for the one approved PO).

## 4. Fetch the agent secrets into `.env` (master admin, read-only)
Run from the repo root:
```bash
KC=http://localhost:8080
ADM=$(curl -s -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin \
  "$KC/realms/master/protocol/openid-connect/token" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
secret() {  # $1 = clientId
  id=$(curl -s -H "Authorization: Bearer $ADM" "$KC/admin/realms/test1/clients?clientId=$1" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
  curl -s -H "Authorization: Bearer $ADM" "$KC/admin/realms/test1/clients/$id/client-secret" | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"])'
}
sed -i '/^AGENT_\(ANALYST\|PLANNER\|EXCEPTION\)_SECRET=/d' .env
{
  echo "AGENT_ANALYST_SECRET=$(secret agent-analyst)"
  echo "AGENT_PLANNER_SECRET=$(secret agent-planner)"
  echo "AGENT_EXCEPTION_SECRET=$(secret agent-exception)"
} >> .env
grep -c '^AGENT_.*_SECRET=.\+' .env   # expect 3
```
The master admin token lives 60 s; rerun the `ADM=` line if you get 401.

Same for `SA_CLIENT_SECRET`: `echo "SA_CLIENT_SECRET=$(secret tidewatch-sa)" >> .env`.

## 5. Quick checks
```bash
# pending CRs (count)
curl -s -H "Authorization: Bearer $ADM" "$KC/admin/realms/test1/iga/change-requests?status=PENDING" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'
# does agent-planner still hold the exception role?
SAU=$(curl -s -H "Authorization: Bearer $ADM" "$KC/admin/realms/test1/clients?clientId=agent-planner" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
SAU=$(curl -s -H "Authorization: Bearer $ADM" "$KC/admin/realms/test1/clients/$SAU/service-account-user" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -H "Authorization: Bearer $ADM" "$KC/admin/realms/test1/users/$SAU/role-mappings/realm" | python3 -c 'import sys,json;print([r["name"] for r in json.load(sys.stdin)])'
```
