[![Built with TideCloak](https://tide.org/badges/built-with-tidecloak.svg)](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked)

## Project overview

Tide Watch is a telemetry and governance console for TideCloak. It shows how close each 14-of-20 key swarm is to failure, catches insiders who decrypt too much, and revokes their access through quorum approval, without becoming a new god mode itself.

Built with [TideCloak](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked).

### 1. Vision & originality

Tide removes god mode by splitting every key across 20 ORK nodes and requiring 14 to use it. But a system without god mode is hard to watch. Operators can't see how many more nodes they can lose, and nobody notices a legitimate user quietly draining data. Tide Watch makes the system observable without a privileged watcher. It holds no keys and no plaintext, stores actors as HMAC hashes, and needs 2 of 3 approvers before a revocation takes effect.

### 2. Trust constraint insight

Today, whoever monitors a system can usually also read its data. Stolen credentials are the top way in, behind [22% of breaches (DBIR 2025)](https://aembit.io/blog/credential-and-secrets-theft-2025-verizon-data-breach-report/). In [Medibank 2022](https://www.oaic.gov.au/__data/assets/pdf_file/0037/228979/Medibank-data-breach-alleged-timeline-infographic.pdf), a contractor's credentials and an admin VPN without MFA exposed 9.7M customers. Tide's own threat model does not stop a valid role from bulk-decrypting. Tide Watch closes that gap using only signals that need no privilege.

### 3. Value & impact

- **Security teams:** if one actor decrypts 50 or more records in 10 minutes, an alert fires in under a second. A one-click proposal then revokes the role once 2 of 3 approvers sign.
- **Platform operators:** each swarm shows its *margin* (how many more ORK failures before a DoS) and its *shard-loss budget* (how many more lost nodes before the key is gone for good). They can fix it before it fails.

### 4. Why TideCloak matters

- KYC data is encrypted with `doEncrypt` and read with `doDecrypt` under `_tide_kyc.selfdecrypt`, so the database holds only ciphertext.
- A revoke is an IGA change request. The server only *proposes* it, and approvers authorize it from their own browsers.
- TideCloak health checks and `tide_*` metrics feed the dashboard.

### 5. Prototype & storytelling

The demo uses 5 browser profiles. A customer submits KYC. Staff open 50 records and the Monitor view turns red. Monitor proposes a revoke, which stays pending after one approval and commits after the second. Staff are then blocked. On the Platform tab, killing 5 ORKs drops the margin to 1.

| Real | Simulated |
|---|---|
| TideCloak login, `doEncrypt`/`doDecrypt`, IGA change requests, TideCloak health + `tide_*` metrics | 20-ORK swarm layer, using the same metric names. No local ORK fabric is available because the ORK image crashes without an undocumented node secret key |

**Limitations**
- An approved user can still copy or screenshot plaintext.
- Two colluding approvers can bypass the quorum.
- One party secretly holding 14 or more ORKs voids the threshold.
- Tide has no independent audit, and its DKG preprint isn't peer-reviewed.
- The client sends the telemetry beacon, so a malicious insider could suppress it.
- The server sees the user id briefly, in memory only, when a revoke is proposed.

## Setup

Prerequisites: Docker (with Compose) and Node 18+.

```bash
git clone <this repo> tidewatch && cd tidewatch
docker compose up -d tidecloak lgtm          # TideCloak :8080 (admin/admin), health/metrics :9000, Grafana :3001
```

1. Realm: follow [infra/realm/README.md](infra/realm/README.md) (realm `tidewatch`, clients `tidewatch-app` + `tidewatch-sa`, roles, users, Tide enrolment, IGA). Put the SA secret in `.env` as `SA_CLIENT_SECRET=...`.
2. In the admin console, go to Clients → `tidewatch-app` → Action → Download adapter config and save it as `web/public/tidecloak.json`.
3. Install and run:

```bash
npm run install:all
set -a; . ./.env; set +a                     # exports SA_CLIENT_SECRET
AUTH_MODE=jwt SIMULATOR=on TIME_SCALE=0.01 PORT=4000 TIDECLOAK_URL=http://localhost:8080 \
  REALM=tidewatch SA_CLIENT_ID=tidewatch-sa HMAC_KEY=change-me DB_PATH=./data/tidewatch.db \
  npm run dev:server                         # API :4000
npm run dev:web                              # second terminal, then open http://localhost:5137
npm test                                     # server unit tests (vitest)
```

**Dev mode without Tide login:** start the server with `AUTH_MODE=dev` instead of `jwt`. It then accepts `X-Dev-Sub` / `X-Dev-Roles` headers in place of a JWT:

```bash
API=http://localhost:4000
# 60 decrypt beacons from one staff actor -> decrypt_anomaly alert (threshold 50)
for i in $(seq 1 60); do curl -s -o /dev/null -X POST $API/api/telemetry/decrypt \
  -H 'X-Dev-Sub: staff1' -H 'X-Dev-Roles: _tide_kyc.selfdecrypt' -H 'Content-Type: application/json' \
  -d '{"tag":"kyc","ok":true,"latency_ms":120,"count":1}'; done
curl -s $API/api/alerts -H 'X-Dev-Sub: monitor1' -H 'X-Dev-Roles: tw-monitor'
# Chaos: kill 5 ORKs -> margin drops to 1 after a few ticks
curl -s -X POST $API/api/chaos -H 'X-Dev-Sub: platform1' -H 'X-Dev-Roles: tw-platform' \
  -H 'Content-Type: application/json' -d '{"action":"kill","node_ids":["ork-01","ork-02","ork-03","ork-04","ork-05"]}'
curl -s $API/api/nodes -H 'X-Dev-Sub: platform1' -H 'X-Dev-Roles: tw-platform'
```

Demo script: [docs/DEMO.md](docs/DEMO.md). Design: [docs/DESIGN.md](docs/DESIGN.md).
