# Realm `tidewatch` — manual setup checklist

Auto-bootstrap is dropped (CONTRACTS D10). Do this once in the admin console
<http://localhost:8080/admin/master/console/> (admin / admin), top to bottom. ~15 min.

Tags: `[measured]` = probed on this TideCloak build (throwaway realm `tidewatch-scratch`, 2026-10-22);
`[inferred]` = from docs / bytecode, not run.

## 0. Order matters (IGA)
Enabling IGA turns **every existing** realm entity into a pending `ADOPT_*` change request, and
clients stay unusable until adopted (`tidewatch-sa` client_credentials → `401 invalid_client`) `[measured]`.
So: create everything in §1–§5 first, enable IGA/Tide in §6 last, then approve the adopt CRs.

## 1. Realm
- [ ] Realm dropdown → **Create realm** → Realm name `tidewatch` → Create.
- [ ] Realm settings → **Tokens** → Access Token Lifespan = **1 minute** (60 s, D8) → Save.
- [ ] Realm settings → **Events** → User events settings: Save events **ON**; Admin events settings: Save events **ON**, Include representation **ON** → Save.

## 2. Clients
`tidewatch-app` (browser login):
- [ ] Clients → Create client → Client ID `tidewatch-app` → Next.
- [ ] Client authentication **OFF** (public), Standard flow **ON** → Next.
- [ ] Root URL `http://localhost:5137`, Valid redirect URIs `http://localhost:5137/*`,
      Valid post logout redirect URIs `http://localhost:5137/*`, Web origins `http://localhost:5137` → Save.

`tidewatch-sa` (server → Admin/IGA API):
- [ ] Clients → Create client → Client ID `tidewatch-sa` → Next.
- [ ] Client authentication **ON**, Standard flow **OFF**, Direct access **OFF**, Service accounts roles **ON** → Save.
- [ ] Tab **Credentials** → copy Client secret → put it in `.env` at repo root as `SA_CLIENT_SECRET=...`.
- [ ] Tab **Service accounts roles** → Assign role → Filter by clients → `realm-management` →
      tick **view-realm**, **view-events**, **manage-users**, **manage-realm** → Assign.
  - `manage-realm` is required: `GET /iga/change-requests` calls `requireManageRealm()`; without it the list returns **403** `[measured]`.
  - Do **NOT** give it `tide-realm-admin` (approver role) — the server must never be able to authorize.

## 3. Realm roles (= `ROLES` in `shared/types.ts`)
Realm roles → Create role, once per row:
- [ ] `_tide_kyc.selfencrypt` — customer (CUSTOMER)
- [ ] `_tide_kyc.selfdecrypt` — staff (STAFF)
- [ ] `tw-monitor` — monitor (MONITOR)
- [ ] `tw-platform` — platform (PLATFORM)

APPROVER is the client role `tide-realm-admin` on `realm-management` (created by TideCloak in Tide realms) — not a realm role.

## 4. Users
Users → Add user (Email verified ON) → Create → **Credentials** → Set password (Temporary OFF) → **Role mapping** → Assign role.

| Username | Password | Roles |
|---|---|---|
| `customer1` | `customer1` | realm `_tide_kyc.selfencrypt` |
| `staff1` | `staff1` | realm `_tide_kyc.selfdecrypt` |
| `monitor1` | `monitor1` | realm `tw-monitor` |
| `platform1` | `platform1` | realm `tw-platform` |
| `approver1`, `approver2`, `approver3` | same as username | client `realm-management` → `tide-realm-admin` (Filter by clients) |

Tide logins go through the Tide enclave, so passwords only matter if the realm still allows plain login.

## 5. Adapter config for the web app
- [ ] Clients → `tidewatch-app` → top-right **Action** → **Download adapter config** → format *Keycloak OIDC JSON* → Download.
      (TideCloak may also show this under the Tide/IGA "Settings" page as `tidecloak.json`.)
- [ ] Save it as `web/public/tidecloak.json` (gitignored). Must contain `"realm": "tidewatch"`,
      `"auth-server-url": "http://localhost:8080"`, `"resource": "tidewatch-app"` (+ Tide `vendorId`/`homeOrkUrl` keys after §6).

## 6. Tide enrolment + IGA (needs a human with a browser)
- [ ] Realm `tidewatch` → Tide / Identity providers → **tide** IdP: set it up / Activate license as the console prompts (same steps used for realm `test1`).
- [ ] Enable IGA: Realm settings → IGA toggle **ON** (REST equivalent: `POST /admin/realms/tidewatch/tide-admin/toggle-iga` form `isIGAEnabled=true` → 200 `[measured]` on the scratch realm). `test1` shows realm attributes `isIGAEnabled=true`, `iga.attestor=tide` `[measured]`.
- [ ] Change requests tab → approve every `ADOPT_*` request (scratch realm: master admin `authorize` + `commit` → 200/200 ×224 `[measured]`; with the Tide attestor the console will ask for enclave sign-off `[inferred]`).
- [ ] For each of `approver1..3`: log in once at <http://localhost:8080/realms/tidewatch/account> → **Link Tide account** (enclave pops up, create/link Tide account). Admin console → Users → user → check the Tide link/`vuid` attribute is present.
- [ ] Re-download `tidecloak.json` (§5) after the Tide IdP is set up so the Tide keys are included.

## 7. Smoke checks
```bash
# SA token (expects 200 + access_token)
curl -s -d grant_type=client_credentials -d client_id=tidewatch-sa -d client_secret="$SA_CLIENT_SECRET" \
  http://localhost:8080/realms/tidewatch/protocol/openid-connect/token | head -c 120; echo
# IGA list via the SA (expects 200 [] ; 403 => manage-realm missing)
TOK=$(curl -s -d grant_type=client_credentials -d client_id=tidewatch-sa -d client_secret="$SA_CLIENT_SECRET" \
  http://localhost:8080/realms/tidewatch/protocol/openid-connect/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -w ' %{http_code}\n' -H "Authorization: Bearer $TOK" 'http://localhost:8080/admin/realms/tidewatch/iga/change-requests?status=PENDING'
```

## Known IGA behaviour `[measured]` on `tidewatch-scratch` (IGA on, default attestor)
- Master admin `DELETE .../users/{id}/role-mappings/realm` → **202** `{"status":"PENDING","changeRequestId":"…","entityType":"USER","actionType":"REVOKE_ROLES"}` + `Location: /admin/realms/{realm}/iga/change-requests/{id}`.
- Same DELETE with the **`tidewatch-sa` token → 204, role removed immediately (not captured)**. Re-check on the real Tide realm before the demo; if still 204, propose-revoke must use an admin user token instead of the SA (or accept the bypass and say so to the judges).
- Role **grant** (`POST role-mappings`) → 204, applied directly even as master admin.
- `createdAt` in CR JSON is epoch ms; `threshold` defaulted to 1 on the scratch realm.

## 8. Export realm JSON into the repo
UI: Realm settings → top-right **Action** → **Partial export** → Include groups and roles ON, Include clients ON → Export → save as `infra/realm/tidewatch-realm.json`.
(Partial export masks client secrets as `**********`; re-set `SA_CLIENT_SECRET` after any import.)

CLI alternative (full, includes users):
```bash
docker compose exec tidecloak /opt/keycloak/bin/kc.sh export --realm tidewatch --users realm_file --file /tmp/tidewatch-realm.json
docker compose cp tidecloak:/tmp/tidewatch-realm.json infra/realm/tidewatch-realm.json
```
