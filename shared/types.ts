// Tide Watch — shared contracts (source of truth for server + web).
// Change only via the orchestrator; tracks must not edit this file.
// Spec: docs/DESIGN.md §7–8; overrides: docs/CONTRACTS.md.

// ---------- Constants ----------
export const SWARM_SIZE = 20;
export const THRESHOLD = 14;
export const MAX_FAULTY = SWARM_SIZE - THRESHOLD; // 6

// Multiply every duration by TIME_SCALE (env, default 1; demo 0.01).
export const RULES = {
  DECRYPT_WINDOW_MS: 10 * 60_000,
  DECRYPT_THRESHOLD: 50, // records decrypted by one actor in the window
  MARGIN_WARN: 3,
  MARGIN_CRIT: 1,
  BUDGET_CRIT: 2,
  TIDECLOAK_DOWN_SAMPLES: 3,
  QUORUM_STALE_MS: 15 * 60_000,
  CONSECUTIVE_SAMPLES: 3, // NFR6: state changes only after N consecutive samples
  SLOW_P95_MS: 2_000,
  SLOW_RECOVER_P95_MS: 1_000,
  DOWN_TO_LOST_MS: 30 * 60_000,
  STALE_RECOVER_OK: 10,
  HEARTBEAT_MS: 15_000,
  POLL_MS: 5_000,
} as const;

// Roles (realm roles unless noted). Server checks these on the JWT.
export const ROLES = {
  CUSTOMER: '_tide_kyc.selfencrypt',
  STAFF: '_tide_kyc.selfdecrypt',
  MONITOR: 'tw-monitor',
  PLATFORM: 'tw-platform',
  APPROVER: 'tide-realm-admin', // client role on realm-management
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

// ---------- Domain ----------
export type NodeState = 'healthy' | 'slow' | 'down' | 'stale' | 'lost';

export interface NodeRow {
  key_id: string;
  node_id: string; // "ork-01".."ork-20"
  state: NodeState;
  since: number; // epoch ms
  p95_ms: number | null;
  last_error: string | null; // e.g. TIDE-ORK-SIG-VERIFY_FAILED
}

export interface KeyHealth {
  key_id: string;
  margin: number; // (healthy + slow) - THRESHOLD; < 0 => DoS
  budget: number; // MAX_FAULTY - (lost + stale); < 0 => key at risk of permanent loss
  dos: boolean; // margin < 0
}

export type AlertKind = 'decrypt_anomaly' | 'key_margin' | 'shard_loss' | 'tidecloak_down' | 'quorum_stale';
export type AlertSeverity = 'info' | 'warn' | 'crit';
export type AlertStatus = 'open' | 'proposed' | 'pending_quorum' | 'resolved' | 'denied' | 'dismissed';

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  subject: string; // actor_hash | key_id
  status: AlertStatus;
  change_request_id: string | null;
  detail: string | null; // human text, never plaintext data or raw sub
  opened_at: number;
  updated_at: number;
}

// Allowed alert transitions (DESIGN §7.3). Anything else => 409.
export const ALERT_TRANSITIONS: Record<AlertStatus, AlertStatus[]> = {
  open: ['proposed', 'dismissed', 'resolved'],
  proposed: ['pending_quorum', 'open'], // back to open if IGA call fails
  pending_quorum: ['resolved', 'denied'],
  resolved: [],
  denied: [],
  dismissed: [],
};

export interface ChangeRequest {
  id: string;
  status: string; // raw IGA status, e.g. PENDING | APPROVED | COMMITTED | DENIED
  summary: string;
  approvals: number;
  required: number;
  updated_at: number;
}

// ---------- SSE /api/stream ----------
export type StreamEvent =
  | { type: 'node.state'; key_id: string; node_id: string; from: NodeState; to: NodeState; ts: number }
  | { type: 'key.margin'; key_id: string; margin: number; budget: number; dos: boolean; ts: number }
  | { type: 'alert.opened'; alert: Alert }
  | { type: 'alert.updated'; alert: Alert }
  | { type: 'cr.updated'; id: string; status: string; approvals: number; required: number }
  | { type: 'decrypt.rate'; actor_hash: string; count_10m: number }
  | { type: 'tidecloak.health'; up: boolean; ts: number }
  | { type: 'heartbeat'; ts: number };

// ---------- REST /api/* (DESIGN §8.1) ----------
export interface ApiError { error: string; code?: string } // code e.g. QUORUM_NOT_MET

// POST /api/kyc  (CUSTOMER) -> 201
export interface KycCreateReq { display_mask: string; payload_ct: string }
export interface KycCreateRes { id: string }

// GET /api/kyc?limit=50&cursor=  (STAFF)
export interface KycItem { id: string; display_mask: string; payload_ct: string; created_at: number }
export interface KycListRes { items: KycItem[]; next_cursor: string | null }

// POST /api/telemetry/decrypt  (any logged-in user) -> 202
// Actor is taken from the JWT, never from the body.
export interface DecryptBeaconReq {
  tag: string; // 'kyc'
  ok: boolean;
  latency_ms: number;
  count: number; // records in this doDecrypt batch (>=1)
  actor_detail_ct?: string; // optional, stretch §9.3
}

// GET /api/nodes?key_id=  (PLATFORM | MONITOR)
export interface NodesRes { key_id: string; nodes: NodeRow[]; health: KeyHealth }

// GET /api/alerts?status=open  (MONITOR)
export interface AlertsRes { items: Alert[] }

// POST /api/alerts/:id/propose-revoke  (MONITOR) -> 202
export interface ProposeRevokeRes { change_request_id: string }

// POST /api/alerts/:id/dismiss  (MONITOR) -> 200
export interface DismissReq { reason: string }

// GET /api/change-requests?status=PENDING  (APPROVER) — read-only proxy of IGA
export interface ChangeRequestsRes { items: ChangeRequest[] }

// POST /api/chaos  (PLATFORM, only when SIMULATOR=on) -> 200
export interface ChaosReq {
  action: 'kill' | 'revive' | 'stale' | 'slow';
  node_ids: string[];
  key_id?: string; // default DEFAULT_KEY_ID
}
export const DEFAULT_KEY_ID = 'kyc-key';

// GET /api/me  (any) — lets the web route by role without decoding JWT twice
export interface MeRes { actor_hash: string; roles: Role[] }
