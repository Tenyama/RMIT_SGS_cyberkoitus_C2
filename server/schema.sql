-- ProcureGuard SQLite schema. Owner: orchestrator. Applied by server/src/db.ts on boot (idempotent).
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS product (
  sku               TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  unit              TEXT NOT NULL,
  on_hand           INTEGER NOT NULL,
  on_order          INTEGER NOT NULL DEFAULT 0,
  avg_daily_demand  REAL NOT NULL,
  safety_stock      INTEGER NOT NULL,
  reference_price   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  approved  INTEGER NOT NULL CHECK (approved IN (0,1))
);

CREATE TABLE IF NOT EXISTS supplier_offer (
  supplier_id     TEXT NOT NULL REFERENCES supplier(id),
  sku             TEXT NOT NULL REFERENCES product(sku),
  unit_price      INTEGER NOT NULL,
  moq             INTEGER NOT NULL,
  lead_time_days  INTEGER NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (supplier_id, sku)
);

CREATE TABLE IF NOT EXISTS purchase_order (
  id                TEXT PRIMARY KEY,
  sku               TEXT NOT NULL REFERENCES product(sku),
  supplier_id       TEXT NOT NULL REFERENCES supplier(id),
  qty               INTEGER NOT NULL CHECK (qty > 0),
  unit_price        INTEGER NOT NULL,
  total             INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('draft','executed','blocked','pending_approval','approved','rejected')),
  created_by        TEXT NOT NULL,
  justification     TEXT NOT NULL DEFAULT '',
  checks_json       TEXT NOT NULL DEFAULT '[]',
  change_request_id TEXT,
  exception_json    TEXT,
  exception_used    INTEGER NOT NULL DEFAULT 0, -- a quorum approval executes exactly one PO, once
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_po_status ON purchase_order(status);

CREATE TABLE IF NOT EXISTS agent_run (
  id          TEXT PRIMARY KEY,
  started_by  TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  summary     TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (     -- hash = sha256(prev_hash || seq || actor || action || target || ts)
  seq INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
  ts INTEGER NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
