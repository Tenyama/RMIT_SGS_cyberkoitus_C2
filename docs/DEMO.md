# Tide Watch — 2-minute demo script

Follows DESIGN §14.3: Possibility → Constraint → Prototype → What changes.

## Pre-flight checklist
- [ ] `docker compose up -d tidecloak lgtm`, and `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9000/health/ready` returns `200`.
- [ ] Server running with `AUTH_MODE=jwt SIMULATOR=on TIME_SCALE=0.01` (README Setup), so the 10-minute rule window becomes 6 s and node state changes take seconds.
- [ ] Realm `tidewatch` → Realm settings → Tokens → Access Token Lifespan = **1 minute** (CONTRACTS D8). This lets a revoked role drop out of staff's token in time.
- [ ] Users `customer1`, `staff1`, `monitor1`, `platform1`, `approver1..3` exist and are Tide-enrolled. Approvers must have **Link Tide account** done (infra/realm/README.md §6).
- [ ] All `ADOPT_*` change requests are approved, and the IGA threshold is 2 (scratch realm defaulted to 1, so check this).
- [ ] Seed **≥ 60 KYC records** as `customer1` on the Customer page ("Khoá & gửi"). Staff loads 50 records (`/api/kyc?limit=50`), so "Mở tất cả (50)" reaches the 50-record threshold. There is no seed script, because records must go through the real `doEncrypt`.
- [ ] Start with an empty alert list (dismiss old alerts) and all 20 ORKs healthy (Platform → select all → `revive`).
- [ ] 5 Chrome profiles, each at http://localhost:5137 and already logged in: **customer**, **staff**, **monitor**, **approver1**, **approver2**. **Platform** is an extra window logged in as `platform1`. Open Grafana http://localhost:3001 in the background.
- [ ] Screen recorder at 1080p, notifications off.

## Script
| Time | Screen / profile | Action | Voice-over |
|---|---|---|---|
| 0:00–0:10 | Title slide | — | "Tide splits every key 14-of-20 across independent nodes. No one holds god mode." |
| 0:10–0:20 | Platform | Show 20 green ORK tiles with margin 6 and budget 6 | "But a system with no god mode still has to be seen. How many nodes can we lose? Who's draining data?" |
| 0:20–0:40 | Title slide: Medibank 2022, DBIR 22% | — | "Medibank: one contractor's credentials exposed 9.7 million people. Stolen credentials are 22% of breaches, and a valid role can still bulk-decrypt." |
| 0:40–0:50 | customer | Submit one KYC record ("Khoá & gửi") | "The customer encrypts in the browser with TideCloak. Our database stores only ciphertext." |
| 0:50–1:00 | staff | Click "Mở tất cả (50)" | "A staff member with a valid role opens 50 files in one go." |
| 1:00–1:08 | monitor | Red `decrypt_anomaly` alert appears and shows only the hashed actor | "Within a second, Monitor sees the anomaly, with no name and no plaintext." |
| 1:08–1:15 | monitor | Click "Đề xuất thu hồi" | "Monitor can only *propose* a revoke. It becomes an IGA change request." |
| 1:15–1:22 | approver1 | Authorize, and the request stays pending (1/2) | "One approver isn't enough." |
| 1:22–1:30 | approver2 | Authorize, and the request is committed | "The second signature commits it." |
| 1:30–1:38 | staff | Click "Mở tất cả" again and get blocked | "Once the token refreshes, staff are blocked." |
| 1:38–1:50 | Platform | Select ork-01..05 → `kill`, and the margin drops to 1 (amber/red) | "Platform sees the swarm one failure away from DoS, before the outage." |
| 1:50–2:00 | Title slide | — | "Tide Watch holds no keys, reads no data, and can't revoke on its own. Even the watcher has no god mode." |

Fallback: if Tide login fails live, run the server with `AUTH_MODE=dev` and replay the curl sequence from README "Dev mode".
