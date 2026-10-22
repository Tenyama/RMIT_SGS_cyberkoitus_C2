# Tide Watch — Design Doc (RFC-001)

| | |
|---|---|
| **Status** | Draft for review |
| **Challenge** | RMIT × Tide "UNLOCKED" (C2) — https://tide.org/unlocked/#challenge |
| **Deadline** | 2026-10-22 18:00 ICT (submit target 17:30) — trang ghi lệch với 23/10 10:00 AEDT, chờ BTC xác nhận |
| **Reviewers** | _(team)_ |
| **Last updated** | 2026-10-22 12:30 ICT |

> **Nhãn bằng chứng:** `[measured]` = team đã chạy/đo; `[docs]` = docs/whitepaper Tide (lời vendor, không có audit độc lập); `[inferred]` = suy luận, cần test.

---

## 1. TL;DR
- **Vấn đề:** Tide bỏ "god mode" bằng cách chia mọi khoá thành 20 mảnh trên 20 node (ORK), cần ≥14 để dùng. Nhưng người vận hành **không nhìn thấy** sức khoẻ của 20 node (còn bao nhiêu node nữa thì sập? node nào giữ mảnh khoá hỏng?) và **không phát hiện** người có quyền hợp lệ đang rút dữ liệu.
- **Giải pháp:** **Tide Watch** — telemetry + governance cho TideCloak: đo sức khoẻ ORK/TideCloak, cảnh báo lạm quyền, đề xuất thu hồi quyền qua quorum. **Bản thân Tide Watch không có god mode**: không giữ key, không đọc được dữ liệu, chi tiết theo user được mã hoá và chỉ mở qua quorum.
- **MVP (5h):** app ngân hàng mini + dashboard realtime; luồng *lạm quyền → đèn đỏ → đề xuất thu hồi → 2/3 duyệt → bị chặn* chạy **thật**; tầng ORK chạy **thật nếu có local fabric**, ngược lại mô phỏng bằng **đúng metric schema của Tide**.

## 2. Bối cảnh

### 2.1 Tide hoạt động thế nào `[docs]`
| Khái niệm | Ý nghĩa |
|---|---|
| **TideCloak** | Fork Keycloak (Apache-2.0), cổng OIDC/OAuth; **không giữ key, không lưu password hash** |
| **Fabric / ORK** | Mạng node độc lập; mỗi key có swarm 20 ORK, ngưỡng **t=14** |
| **Ineffable Key** | Sinh bằng Nested Shamir DKG, *"complete private key is never computed by any party"* |
| **SWE** (Secure Web Enclave) | JS trong browser (SRI-pinned), giữ session key trong RAM, bóc lớp giải mã cuối |
| **QEA / IGA** | Thay đổi quyền → *change request*, chỉ commit khi đủ quorum admin ký |
| **E2EE theo tag** | `doEncrypt([{data,tags}])` / `doDecrypt([{encrypted,tags}])`, role `_tide_<tag>.selfencrypt/.selfdecrypt` |
| **Key Healing / Proactive Secret Sharing** | Node chết → node khoẻ tính shard mới cho node thay thế; shard được làm mới định kỳ |

### 2.2 Ngưỡng chịu lỗi (mỗi swarm) `[docs]`
| ORK hỏng | Bảo mật | Hoạt động |
|---|---|---|
| 0–6 | OK | OK |
| 7–13 | OK (*"cannot breach confidentiality or integrity"*) | **DoS** cho key trên swarm đó |
| ≥14 thông đồng | **Mất key** | — |
| ≥7 mất shard vĩnh viễn trước khi heal | — | **Mất key vĩnh viễn** `[inferred]` (Shamir cần ≥14 shard) |

### 2.3 TideCloak vs Keycloak (vì sao cần Tide)
| Rủi ro | Keycloak | TideCloak |
|---|---|---|
| Lộ DB | Lộ hash + khoá ký JWT (nằm trong DB) → giả token | Chỉ ciphertext; khoá ký chia 14/20 |
| Admin bị chiếm | Tự gán mọi quyền | Change request cần quorum |
| Dữ liệu app | Plaintext hoặc KMS mà server tự gọi được | Chỉ giải khi token có role, Fabric thực thi |

### 2.4 Khoảng trống Tide Watch lấp
| # | Khoảng trống | Hậu quả |
|---|---|---|
| G1 | Không thấy **margin** trước DoS | Biết khi đã sập |
| G2 | Không thấy node `lost`/`stale` tích luỹ | Có thể mất key vĩnh viễn |
| G3 | Không chặn người có role hợp lệ rút dần dữ liệu (credential bị đánh cắp) | Tide tự nhận không bảo vệ |
| G4 | Quorum bị duyệt cho có | Governance thành hình thức |

Bối cảnh ngành: credential abuse là cửa vào #1, 22% breach (DBIR 2025); Medibank 2022 — credential contractor + admin VPN không MFA; insider risk ~$17.4M/tổ chức/năm (Ponemon/DTEX 2025). Nguồn ở §15.

## 3. Goals / Non-goals
**Goals**
1. Realtime sức khoẻ TideCloak + ORK: `healthy/slow/down/stale/lost`, margin, shard-loss budget.
2. Phát hiện giải mã bất thường theo user/tag.
3. Đề xuất thu hồi role qua IGA → quorum 2/3 → hiệu lực.
4. Telemetry **không tạo god mode mới** (không key, không plaintext, drill-down cần quorum).

**Non-goals (MVP)**
- Điều phối/dời shard, trigger Key Healing (Fabric quản).
- Anomaly bằng ML, multi-vantage probing, Forseti policy.
- Chặn người hợp lệ copy dữ liệu sau khi giải mã; chặn approver thông đồng.

## 4. Personas & user stories
| Persona | Story |
|---|---|
| Khách hàng | Nộp CCCD/thu nhập; dữ liệu bị khoá ngay trên browser |
| Nhân viên thẩm định | Có role `_tide_kyc.selfdecrypt`; mở hồ sơ để làm việc (và là kẻ lạm quyền trong demo) |
| Người giám sát (SecOps) | Xem dashboard, nhận cảnh báo, **đề xuất** thu hồi — không tự thu hồi được |
| Approver ×3 (Risk, Compliance, Ops) | Duyệt/từ chối change request; cần 2/3 |
| Platform engineer | Xem ORK/TideCloak health, margin, shard-loss budget |

## 5. Kiến trúc

### 5.1 Component diagram
```
                    ┌───────────── Tide Fabric (swarm 20 ORK / key) ─────────────┐
                    │  ORK1 … ORK20   ──OTLP gRPC :4317──┐  (chỉ khi local fabric) │
                    └─────────▲───────────────────────────┼─────────────────────────┘
                              │ ORK calls                 │
┌───────────────────┐  ┌──────┴────────────────────┐      │
│ Browser           │  │ TideCloak (tidecloak-dev) │      │
│  SWE + SDK        │─►│  :8080 OIDC, Admin, IGA   │      │
│  doEncrypt/Decrypt│  │  :9000 /health /metrics   │      │
└────────┬──────────┘  └──────┬───────────┬────────┘      │
         │ telemetry beacon    │ scrape    │ REST poll     │
         ▼                     ▼           │               ▼
┌─────────────────────────────────────┐   │   ┌──────────────────────────┐
│ app (Next.js)                       │   │   │ otel-collector           │
│  UI: Khách · Nhân viên · Giám sát · │   │   │  recv OTLP :4317         │
│      Approver · Platform            │   │   │  export Prometheus :8889 │
│  API routes (REST) + SSE /api/stream│◄──┘   └────────────┬─────────────┘
│  worker: pollers + rules engine     │                    │
│  SQLite (WAL)                       │◄── PromQL ── ┌─────▼──────┐
└─────────────────────────────────────┘              │ prometheus │ scrape tidecloak:9000,
                                                     │   :9090    │ otel:8889, app:/api/metrics
                                    ┌────────────┐   └────────────┘
                                    │ simulator  │──OTLP──► otel-collector (chỉ khi KHÔNG có local fabric)
                                    └────────────┘
```

### 5.2 Trust boundaries
| Vùng | Được tin để | Không được tin để |
|---|---|---|
| Browser + SWE | Giữ session key, thấy plaintext của chính user | — |
| TideCloak | Định tuyến, gom partial | Giữ key, ký token một mình |
| app / worker | Hiển thị, tính rule, **tạo** change request | Giải mã, **duyệt** change request, sửa role trực tiếp |
| Prometheus / SQLite | Lưu số tổng, ciphertext | Lưu plaintext, user ID dạng rõ trong metric |

### 5.3 Tech stack
| Lớp | Chọn | Lý do |
|---|---|---|
| IAM | `tideorg/tidecloak-dev:latest` | Bắt buộc |
| App + API + SSE | Next.js (template `npm init @tidecloak/nextjs@latest`), TypeScript, Tailwind | SDK có sẵn, 1 repo |
| Worker | Node.js process trong cùng repo (`tsx worker/index.ts`) | Ít service |
| Store | SQLite `better-sqlite3`, WAL | Không cần DB server |
| Metrics | OpenTelemetry Collector + Prometheus | Tide đã emit OTLP/Prometheus `[docs]` |
| Realtime | SSE | 1 chiều, đơn giản hơn WebSocket |
| Chạy | `docker compose` | 1 lệnh |

## 6. Bootstrap — khởi tạo platform cùng lúc với TideCloak

### 6.1 `docker-compose.yml` (rút gọn)
```yaml
services:
  tidecloak:
    image: tideorg/tidecloak-dev:latest
    ports: ["8080:8080", "9000:9000"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
      KC_HEALTH_ENABLED: "true"      # [inferred] Keycloak chuẩn, chưa test trên bản Tide
      KC_METRICS_ENABLED: "true"
    healthcheck:
      test: ["CMD-SHELL", "exec 3<>/dev/tcp/localhost/9000 && printf 'GET /health/ready HTTP/1.0\r\n\r\n' >&3 && grep -q UP <&3"]
      interval: 10s
      retries: 30
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.111.0
    ports: ["4317:4317", "8889:8889"]
    volumes: ["./infra/otel.yaml:/etc/otelcol-contrib/config.yaml"]
  prometheus:
    image: prom/prometheus:v2.54.1
    ports: ["9090:9090"]
    volumes: ["./infra/prometheus.yml:/etc/prometheus/prometheus.yml"]
  bootstrap:
    build: ./infra/bootstrap
    depends_on: { tidecloak: { condition: service_healthy } }
    restart: "no"
  app:
    build: .
    ports: ["3000:3000"]
    depends_on: { bootstrap: { condition: service_completed_successfully } }
    environment:
      TIDECLOAK_URL: http://tidecloak:8080
      PROM_URL: http://prometheus:9090
      SIMULATOR: "${SIMULATOR:-on}"
```

### 6.2 Trình tự khởi tạo
| # | Bước | Ai | Tự động? |
|---|---|---|---|
| 1 | `tidecloak` up, `/health/ready` = UP | compose | ✅ |
| 2 | `otel-collector`, `prometheus` up; Prometheus scrape `tidecloak:9000/metrics` | compose | ✅ |
| 3 | `bootstrap`: lấy admin token → tạo realm `tidewatch`, client `tidewatch-app`, roles `_tide_kyc.selfencrypt`, `_tide_kyc.selfdecrypt`, `_tide_telemetry_detail.selfdecrypt`, `tide-realm-admin` ×3 approver, user mẫu, bật login/admin events, service account `tidewatch-sa` | script (Admin REST) | ✅ |
| 4 | **Tide enrolment** (link Tide account qua enclave) cho admin + 3 approver; gán Quorum | người | ❌ thủ công `[docs]` |
| 5 | `app` up: worker bắt đầu poll, SSE sẵn sàng | compose | ✅ |
| 6 | Smoke test: `GET :9000/metrics \| grep tide_`, login 1 user, `doEncrypt` 1 bản ghi | người/CI | bán tự động |

### 6.3 Scrape & OTLP config
```yaml
# infra/prometheus.yml
scrape_configs:
  - job_name: tidecloak
    static_configs: [{ targets: ["tidecloak:9000"] }]
  - job_name: ork            # OTLP → collector → Prometheus exporter
    static_configs: [{ targets: ["otel-collector:8889"] }]
  - job_name: tidewatch
    metrics_path: /api/metrics
    static_configs: [{ targets: ["app:3000"] }]
```
```yaml
# infra/otel.yaml
receivers: { otlp: { protocols: { grpc: { endpoint: 0.0.0.0:4317 } } } }
exporters: { prometheus: { endpoint: 0.0.0.0:8889 } }
service: { pipelines: { metrics: { receivers: [otlp], exporters: [prometheus] } } }
```

## 7. Data model

### 7.1 SQLite (app)
```sql
CREATE TABLE kyc_record (
  id            TEXT PRIMARY KEY,          -- uuid
  owner_sub     TEXT NOT NULL,             -- OIDC sub của khách
  display_mask  TEXT NOT NULL,             -- "Nguyen V. A · 09***123" (không nhạy cảm)
  payload_ct    TEXT NOT NULL,             -- ciphertext từ doEncrypt, tag 'kyc'
  created_at    INTEGER NOT NULL
);

CREATE TABLE decrypt_event (               -- nguồn: SDK wrapper beacon
  id            INTEGER PRIMARY KEY,
  actor_hash    TEXT NOT NULL,             -- HMAC(sub) — metric không chứa sub rõ
  actor_detail_ct TEXT NOT NULL,           -- doEncrypt({sub, record_id}, tag 'telemetry_detail')
  tag           TEXT NOT NULL,
  ok            INTEGER NOT NULL,          -- 1/0
  latency_ms    INTEGER NOT NULL,
  ts            INTEGER NOT NULL
);
CREATE INDEX ix_decrypt_actor_ts ON decrypt_event(actor_hash, ts);

CREATE TABLE node_state (                  -- state hiện tại mỗi (key, node)
  key_id        TEXT NOT NULL,
  node_id       TEXT NOT NULL,             -- ORK id/URL
  state         TEXT NOT NULL CHECK (state IN ('healthy','slow','down','stale','lost')),
  since         INTEGER NOT NULL,
  p95_ms        INTEGER,
  last_error    TEXT,                      -- vd TIDE-ORK-SIG-VERIFY_FAILED
  PRIMARY KEY (key_id, node_id)
);

CREATE TABLE node_event (                  -- lịch sử chuyển trạng thái
  id INTEGER PRIMARY KEY, key_id TEXT, node_id TEXT,
  from_state TEXT, to_state TEXT, reason TEXT, trace_id TEXT, ts INTEGER
);

CREATE TABLE alert (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('decrypt_anomaly','key_margin','shard_loss','tidecloak_down','quorum_stale')),
  severity      TEXT NOT NULL CHECK (severity IN ('info','warn','crit')),
  subject       TEXT NOT NULL,             -- actor_hash | key_id
  status        TEXT NOT NULL CHECK (status IN ('open','proposed','pending_quorum','resolved','denied','dismissed')),
  change_request_id TEXT,                  -- IGA id khi đã đề xuất
  opened_at     INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE change_request_mirror (       -- bản sao đọc từ IGA, để SSE
  id TEXT PRIMARY KEY, status TEXT, summary TEXT,
  approvals INTEGER, required INTEGER, updated_at INTEGER
);

CREATE TABLE audit_log (                   -- hash-chain, tamper-evident
  seq INTEGER PRIMARY KEY, actor_hash TEXT, action TEXT, target TEXT,
  ts INTEGER, prev_hash TEXT, hash TEXT     -- hash = SHA256(prev_hash || row)
);
```

### 7.2 Metrics
| Metric | Nguồn | Labels | Dùng cho |
|---|---|---|---|
| `tide_ork_outbound_duration_seconds` | ORK (OTLP) `[docs]` | `target, endpoint, status` | slow/down từng peer |
| `tide_crypto_errors_total` | ORK `[docs]` | `type, scheme, side` | stale (verify fail) |
| `tide_ork_protocol_duration_seconds` | ORK `[docs]` | `op, phase` | GenShard/SendShard/Commit/Sign |
| `tide_ork_throttle_rejections_total` | ORK `[docs]` | — | quá tải |
| `tide_token_issue_duration_seconds` | TideCloak `[docs]` | `path, alg, result` | phát token |
| `tide_idp_login_duration_seconds` | TideCloak `[docs]` | `phase, sso, result` | login |
| `tidewatch_decrypt_total` | app | `tag, ok` | volume giải mã |
| `tidewatch_node_state` | worker | `key_id, node_id, state` | gauge 0/1 |
| `tidewatch_key_margin` | worker | `key_id` | healthy − 14 |
| `tidewatch_shard_loss_budget` | worker | `key_id` | 6 − (lost + stale) |

> Tên Prometheus = tên OTel đổi `.`→`_` + hậu tố đơn vị `[docs]`. Simulator phát **đúng** các tên `tide_*` này.

### 7.3 State machines
**Node (per key)**
```
healthy ──p95>2s──► slow ──p95<1s 3 lần──► healthy
   │ timeout×3          │ timeout×3
   ▼                    ▼
  down ──>30 phút──► lost          (any) ──verify_failed×3──► stale
   │ ok×3                          stale ──ok×10 (sau refresh)──► healthy
   ▼
 healthy
```
**Alert**
```
open ──giám sát bấm đề xuất──► proposed ──IGA 202──► pending_quorum ──commit──► resolved
  │                                                     └──deny──► denied
  └──dismiss──► dismissed
```

### 7.4 Rules (MVP, tĩnh)
| Rule | Điều kiện | Severity |
|---|---|---|
| `decrypt_anomaly` | ≥50 `decrypt_event` cùng `actor_hash` trong 10' | crit |
| `key_margin` | margin ≤3 / ≤1 | warn / crit |
| `shard_loss` | budget ≤2 | crit |
| `tidecloak_down` | `/health/ready` ≠ UP 3 lần | crit |
| `quorum_stale` | change request pending > 15' | warn |

## 8. API

### 8.1 App API (Next.js route handlers)
| Method | Path | Auth (role) | Body / Query | Response |
|---|---|---|---|---|
| POST | `/api/kyc` | khách | `{ display_mask, payload_ct }` (client đã `doEncrypt`) | `201 {id}` |
| GET | `/api/kyc` | nhân viên | `?limit=50&cursor=` | `[{id, display_mask, payload_ct}]` — server **không bao giờ** giải mã |
| POST | `/api/telemetry/decrypt` | user đã login | `{ tag, ok, latency_ms, actor_detail_ct }` | `202` (fire-and-forget) |
| GET | `/api/stream` | giám sát/approver/platform | — | **SSE** (§8.3) |
| GET | `/api/nodes` | platform | `?key_id=` | `[{node_id, state, since, p95_ms, last_error}]` + `{margin, budget}` |
| GET | `/api/alerts` | giám sát | `?status=open` | `[alert]` |
| POST | `/api/alerts/:id/propose-revoke` | giám sát | — | `202 {change_request_id}` — gọi IGA bằng `tidewatch-sa` |
| POST | `/api/alerts/:id/dismiss` | giám sát | `{reason}` | `200` |
| GET | `/api/change-requests` | approver | `?status=PENDING` | proxy IGA list |
| GET | `/api/metrics` | Prometheus | — | Prometheus text `tidewatch_*` |
| POST | `/api/chaos` | platform, **chỉ khi `SIMULATOR=on`** | `{ action: 'kill'\|'revive'\|'stale', node_ids: [] }` | `200` |

> **Duyệt change request không đi qua app API**: approver gọi IGA `authorize` bằng **token của chính họ** (có thể cần ký qua Tide enclave) → app không thể duyệt hộ. `[inferred]` — test ở U5.

### 8.2 TideCloak endpoints dùng `[docs]`
| Method | Path | Dùng ở |
|---|---|---|
| POST | `/realms/{realm}/protocol/openid-connect/token` | bootstrap, worker (`tidewatch-sa`) |
| GET | `:9000/health/ready`, `:9000/metrics` | Prometheus, worker |
| GET | `/admin/realms/{realm}/events`, `/admin-events` | worker (login fail, gán role) |
| POST | `/admin/realms/{realm}/users/{id}/role-mappings/realm` | gán role → **202** dưới QEA |
| DELETE | `/admin/realms/{realm}/users/{id}/role-mappings/realm` | thu hồi role → **202** `[inferred]` |
| GET | `/admin/realms/{realm}/iga/change-requests?status=PENDING` | worker poll 5s |
| GET | `/admin/realms/{realm}/iga/change-requests/{id}` | chi tiết |
| POST | `.../iga/change-requests/{id}/authorize` | approver UI (token approver); auto-commit khi đủ quorum |
| POST | `.../iga/change-requests/{id}/commit` | `412 QUORUM_NOT_MET` nếu thiếu |
| POST | `.../iga/change-requests/{id}/deny` | approver UI |
| PUT | `.../iga/change-requests/{id}` | **xoá hết chữ ký** — demo chống tráo nội dung |

Mã trạng thái cần xử lý: `202` captured · `403` không phải approver · `409` đã ký/không pending · `412` thiếu quorum · `404 ENTITY_VANISHED`.

### 8.3 SSE event schema (`/api/stream`)
```ts
type StreamEvent =
  | { type: 'node.state';   key_id: string; node_id: string; from: NodeState; to: NodeState; ts: number }
  | { type: 'key.margin';   key_id: string; margin: number; budget: number; ts: number }
  | { type: 'alert.opened'; alert: Alert }
  | { type: 'alert.updated';alert: Alert }
  | { type: 'cr.updated';   id: string; status: string; approvals: number; required: number }
  | { type: 'decrypt.rate'; actor_hash: string; count_10m: number }
  | { type: 'heartbeat';    ts: number };              // 15s, giữ kết nối
```

## 9. Realtime dataflow

### 9.1 Lạm quyền → thu hồi (luồng chính)
```
Nhân viên ──doDecrypt──► SWE ⇄ TideCloak ⇄ ORK×14        (≈1.5–4s/lần, số cũ — đo lại)
    └──beacon POST /api/telemetry/decrypt (≤20ms, không chặn UI)
worker: INSERT decrypt_event → đếm cửa sổ 10' → ≥50 → INSERT alert(open) → SSE alert.opened   (<1s)
Giám sát ──POST /api/alerts/:id/propose-revoke──► app ──DELETE role-mapping (tidewatch-sa)──► TideCloak → 202
worker poll IGA 5s → cr.updated 0/2 → Approver1 authorize → 1/2 → Approver2 authorize → auto-commit
worker: alert → resolved; Nhân viên doDecrypt tiếp → Fabric từ chối → beacon ok=0
```

### 9.2 Sức khoẻ ORK
```
ORK (thật hoặc simulator) ──OTLP──► otel-collector ──► Prometheus (scrape 5s)
worker mỗi 5s: PromQL
  rate(tide_ork_outbound_duration_seconds_count{status!="200"}[1m]) by (target)  → down
  histogram_quantile(0.95, rate(tide_ork_outbound_duration_seconds_bucket[1m])) → slow
  increase(tide_crypto_errors_total[5m])                                         → stale
→ cập nhật node_state → tính margin/budget → SSE node.state, key.margin
```

### 9.3 Drill-down "ai" (stretch)
Giám sát xin role `_tide_telemetry_detail.selfdecrypt` → IGA 202 → 2/3 duyệt → `doDecrypt(actor_detail_ct)` trên browser giám sát. Mặc định chỉ thấy `actor_hash`.

## 10. Non-functional requirements
| ID | Yêu cầu | Cách đạt |
|---|---|---|
| NFR1 | Không god mode mới | `tidewatch-sa` chỉ `view-realm`, `view-events`, quyền tạo role-mapping change; không có quyền authorize |
| NFR2 | Không nằm trên auth path | Beacon fire-and-forget; app/worker chết → login/giải mã vẫn chạy |
| NFR3 | Latency cảnh báo | Sự kiện → SSE < 1s (rule app); metric ORK < 10s (scrape 5s + poll 5s) |
| NFR4 | Privacy | Không plaintext; metric không chứa `sub` rõ (HMAC); retention 30 ngày |
| NFR5 | Tamper-evident | `audit_log` hash-chain |
| NFR6 | Chống báo động giả | State chỉ đổi sau 3 mẫu liên tiếp |
| NFR7 | Overhead | Beacon < 20ms; scrape 5s |
| NFR8 | Tái lập | `docker compose up` + 1 bước enrolment thủ công |

## 11. Feasibility

### 11.1 Đã test `[measured]` (12:20)
- `tideorg/ork:latest` (built 2026-10-19, .NET 10, port 8080, `dotnet Ork.dll`) → crash: `System.Exception: Node secret key not provided`. Không có doc config.
- Local fabric cần thêm node secret key, master (`sork1/sork2`), payer, registry → **không có doc**.
- 12:45 — stack `docker-compose.yml` (`grafana/otel-lgtm:0.37.0` + `tidecloak-dev`, Keycloak **26.7.5**) chạy được:
  - `:9000/health/ready` 200, `:9000/metrics` 200 (1776 dòng) — **chỉ metric Keycloak/HTTP chuẩn, KHÔNG có `tide_*`** (U2 = không).
  - `KC_TRACING_ENABLED` là build-time option → image đã build sẵn **exit 2**; bỏ tracing (muốn có phải build image riêng).
  - Grafana trong lgtm chết khi preinstall plugin (nghi VPN chặn tải) → `GF_PLUGINS_PREINSTALL_DISABLED=true`.
  - Prometheus của lgtm scrape `tidecloak:9000` → `up{job="tidecloak"}=1`.
  - IGA `GET /admin/realms/master/iga/change-requests?status=PENDING` → **200** (endpoint có trên dev; QEA 202 chưa test).
  - Realm có sẵn: `master`, `myrealm`.
  - **Thay đổi thiết kế**: `otel-collector` + `prometheus` → 1 container `lgtm` (Grafana :3001, OTLP :4317/:4318, Prometheus datasource uid `prometheus`).

### 11.2 Thật vs mô phỏng
| Phần | MVP | Điều kiện |
|---|---|---|
| Login, `doEncrypt/doDecrypt`, beacon, rule, SSE | **Thật** | — |
| Đề xuất thu hồi → IGA → 2/3 duyệt | **Thật** | U1: QEA trả 202 |
| TideCloak health/metrics `tide_token_*`, `tide_idp_*` | **Thật** | U2: `:9000/metrics` có trên bản dev |
| ORK node state | **Thật nếu có local fabric** (Track A), ngược lại **simulator cùng schema** (Track B) | Tide trả lời Discord trước 14:00 |
| "Key rác" (stale) | Thật chỉ khi ORK emit `tide_crypto_errors` / `SIG-VERIFY_FAILED` | Track A |

### 11.3 Unknowns (test theo thứ tự)
| ID | Câu hỏi | Nếu KHÔNG |
|---|---|---|
| U1 | Gán/xoá role trả **202** (QEA bật trên dev)? | Mock bước duyệt trong app, ghi README |
| U2 | `:9000/metrics` có series `tide_*`? | Chỉ dùng `/health` + events |
| U3 | Tide cấp cấu hình local fabric? | Track B simulator |
| U4 | `doDecrypt` lỗi trả về đủ phân biệt "không có role" vs "Fabric lỗi"? | Gộp thành `ok=0` |
| U5 | `authorize` cần ký qua enclave của approver? | Nếu không cần: vẫn bắt approver dùng token riêng |
| U6 | Role `selfdecrypt` giải được dữ liệu user khác mã hoá? (whitepaper: quyền theo role) | Đổi luồng: dữ liệu mã hoá dưới tài khoản tổ chức |

## 12. Failure modes
| Sự cố | Ảnh hưởng | Tide Watch hiển thị |
|---|---|---|
| ≤6 ORK down | Không | vàng/đỏ theo margin |
| 7–13 ORK down | Key trên swarm đứng | đen "DoS", budget |
| ≥7 ORK lost/stale | Nguy cơ mất key | crit `shard_loss` |
| TideCloak down | Login/giải mã đứng | crit `tidecloak_down` |
| Tide Watch down | **Không ảnh hưởng app** | dashboard mất kết nối SSE |
| Prometheus down | Mất node layer | banner "metrics unavailable" |

## 13. Giới hạn (nói trước với BGK)
- Người được duyệt hợp lệ vẫn copy/chụp được plaintext.
- ≥2/3 approver thông đồng → vượt quorum.
- 1 bên âm thầm nắm ≥14 node → *"renders the threshold meaningless"* `[docs]`; Tide Watch chỉ cảnh báo tập trung khi biết operator/ASN.
- Phụ thuộc mạng ngoài; latency cũ ~1.5–4s/lần.
- Không có audit độc lập cho Tide; preprint DKG chưa peer-review.

## 14. Kế hoạch MVP

### 14.1 Timeline & cổng quyết định
| Giờ | Việc | Cổng |
|---|---|---|
| 12:30–13:15 | compose (tidecloak + otel + prometheus) + bootstrap script; enrolment; test **U1, U2** | **13:15: U1 fail → mock duyệt** |
| 13:15–14:45 | Trang Khách/Nhân viên + `doEncrypt/doDecrypt` + beacon; worker + rules + SSE | **14:00: U3 chưa có → chốt Track B** |
| 14:45–15:45 | Dashboard Giám sát/Approver/Platform; IGA flow; simulator + `/api/chaos` | 15:45: chưa xong → bỏ §9.3 |
| 15:45–16:00 | Smoke test toàn luồng | |
| 16:00–17:00 | Video 2' (5 browser profile) + README ≤300 từ | |
| 17:00–17:30 | Push public, nộp Form | buffer |

### 14.2 Chia việc
| Người | Phần |
|---|---|
| A | compose, bootstrap, IGA (U1/U5), approver UI |
| B | Khách/Nhân viên, SDK wrapper + beacon (U4/U6) |
| C | worker, rules, SSE, dashboard, Prometheus/simulator (U2/U3) |
| D | README, kịch bản, video, slide stakeholder; hỏi Tide Discord (U3) |

### 14.3 Demo script (2')
1. **Possibility** (0:00–0:20): "Bỏ god mode — nhưng phải *nhìn thấy* hệ thống không god mode."
2. **Constraint** (0:20–0:40): Medibank; Tide tự nhận không chặn người có quyền hợp lệ.
3. **Prototype** (0:40–1:30): khách nộp → DB rác · nhân viên mở 200 hồ sơ → đỏ · đề xuất thu hồi → 1/3 treo → 2/3 → nhân viên bị chặn · tắt 5 ORK → margin 1.
4. **What changes** (1:30–2:00): "Kể cả người giám sát cũng không có god mode."

## 15. References
- Challenge: https://tide.org/unlocked/#challenge
- Docs: [architecture](https://docs.tide.org/architecture) · [core concepts](https://docs.tide.org/Core-Concepts/core-concepts) · [Hermetic E2EE](https://docs.tide.org/Core-Concepts/hermetic-e2ee) · [Management API](https://docs.tide.org/API/Management%20API) · [ORK metrics](https://docs.tide.org/ORK/ork-metrics) · [ORK errors](https://docs.tide.org/ORK/ork-errors) · [Quick deploy](https://docs.tide.org/Admin/Quick-deploy-test) · [React SDK](https://docs.tide.org/Languages/React/tidecloak-react-intro)
- Whitepaper: [key-lifecycle](https://tide.org/whitepaper/key-lifecycle) · [threat-model](https://tide.org/whitepaper/threat-model) · [authority-in-action](https://tide.org/whitepaper/authority-in-action) · [client-architecture](https://tide.org/whitepaper/client-architecture) · [tidecloak-integration](https://tide.org/whitepaper/tidecloak-integration)
- Code: [tide-foundation/tidecloak](https://github.com/tide-foundation/tidecloak) (Apache-2.0) · [arXiv 2309.00915](https://arxiv.org/abs/2309.00915) (preprint)
- Ngành: [DBIR 2025 (Aembit)](https://aembit.io/blog/credential-and-secrets-theft-2025-verizon-data-breach-report/) · [Medibank OAIC](https://www.oaic.gov.au/__data/assets/pdf_file/0037/228979/Medibank-data-breach-alleged-timeline-infographic.pdf) · [Ponemon/DTEX](https://ponemon.dtexsystems.com) · [Keycloak key-in-DB report](https://dev.to/senso/keycloak-tm-2-134m)
