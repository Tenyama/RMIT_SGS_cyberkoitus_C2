-- Tide Watch SQLite schema (DESIGN §7.1 + overrides in docs/CONTRACTS.md).
-- Owner: orchestrator. Applied by server/src/db.ts on boot (idempotent).
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS kyc_record (
  id            TEXT PRIMARY KEY,
  owner_hash    TEXT NOT NULL,             -- HMAC(sub) of the customer
  display_mask  TEXT NOT NULL,             -- non-sensitive, e.g. "Nguyen V. A · 09***123"
  payload_ct    TEXT NOT NULL,             -- doEncrypt ciphertext, tag 'kyc'
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decrypt_event (
  id              INTEGER PRIMARY KEY,
  actor_hash      TEXT NOT NULL,           -- HMAC(sub) from the JWT
  actor_detail_ct TEXT,                    -- optional, stretch §9.3
  tag             TEXT NOT NULL,
  ok              INTEGER NOT NULL CHECK (ok IN (0,1)),
  count           INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  latency_ms      INTEGER NOT NULL,
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_decrypt_actor_ts ON decrypt_event(actor_hash, ts);

CREATE TABLE IF NOT EXISTS node_state (
  key_id     TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('healthy','slow','down','stale','lost')),
  since      INTEGER NOT NULL,
  p95_ms     INTEGER,
  last_error TEXT,
  PRIMARY KEY (key_id, node_id)
);

CREATE TABLE IF NOT EXISTS node_event (
  id INTEGER PRIMARY KEY, key_id TEXT NOT NULL, node_id TEXT NOT NULL,
  from_state TEXT, to_state TEXT NOT NULL, reason TEXT, trace_id TEXT, ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('decrypt_anomaly','key_margin','shard_loss','tidecloak_down','quorum_stale')),
  severity          TEXT NOT NULL CHECK (severity IN ('info','warn','crit')),
  subject           TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('open','proposed','pending_quorum','resolved','denied','dismissed')),
  change_request_id TEXT,
  detail            TEXT,
  opened_at         INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
-- At most one active alert per (kind, subject) so rules don't spam.
CREATE UNIQUE INDEX IF NOT EXISTS ux_alert_active ON alert(kind, subject)
  WHERE status IN ('open','proposed','pending_quorum');

CREATE TABLE IF NOT EXISTS change_request_mirror (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, summary TEXT,
  approvals INTEGER NOT NULL DEFAULT 0, required INTEGER NOT NULL DEFAULT 2, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (     -- hash = sha256(prev_hash || seq || actor_hash || action || target || ts)
  seq INTEGER PRIMARY KEY, actor_hash TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
  ts INTEGER NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
