// ProcureGuard — shared contracts (source of truth for server + web).
// Change only via the orchestrator; tracks must not edit this file.
// Spec: docs/DESIGN.md; overrides + ownership: docs/CONTRACTS.md.

// ---------- Identities & roles (TideCloak realm `test1`) ----------
// Realm roles unless noted. The server re-checks these on EVERY consequential call.
export const ROLES = {
  AGENT_ANALYST: 'agent.analyst',
  AGENT_PLANNER: 'agent.planner',
  AGENT_EXCEPTION: 'agent.exception',
  EXCEPTION_SUBMIT: 'proc.exception-submit', // temporary, granted ONLY via IGA quorum
  BUYER: 'proc.buyer',
  AUDITOR: 'proc.auditor',
  APPROVER: 'tide-realm-admin', // client role on realm-management; approves in TideCloak, never in our app
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

// TideCloak client ids of the three agents (service accounts, client_credentials).
export const AGENT_CLIENTS = {
  analyst: 'agent-analyst',
  planner: 'agent-planner',
  exception: 'agent-exception',
} as const;
export type AgentName = keyof typeof AGENT_CLIENTS;

export type Permission =
  | 'inventory:read'
  | 'supplier:read'
  | 'po:read'
  | 'po:draft'
  | 'po:submit'
  | 'exception:report'
  | 'agents:run'
  | 'audit:read'
  | 'demo:inject';

// Role -> permissions. The ONLY place authority is defined; the LLM never decides it.
export const PERMISSIONS: Record<string, Permission[]> = {
  [ROLES.AGENT_ANALYST]: ['inventory:read', 'supplier:read'],
  [ROLES.AGENT_PLANNER]: ['inventory:read', 'supplier:read', 'po:draft', 'po:submit'],
  [ROLES.AGENT_EXCEPTION]: ['inventory:read', 'supplier:read', 'po:read', 'exception:report'],
  [ROLES.BUYER]: ['inventory:read', 'supplier:read', 'po:read', 'agents:run', 'demo:inject'],
  [ROLES.AUDITOR]: ['po:read', 'audit:read', 'inventory:read'],
};

// ---------- Business policy (deterministic, enforced in server/src/policy.ts) ----------
export const POLICY = {
  CURRENCY: 'VND',
  AGENT_PO_LIMIT: 10_000_000, // per order an agent may execute alone
  AGENT_DAILY_LIMIT: 30_000_000, // sum of agent-executed orders per day
  PRICE_TOLERANCE: 0.2, // unit price may deviate ±20% from reference_price
  MAX_QTY_FACTOR: 3, // qty may not exceed 3× the deterministic recommendation
  REVIEW_DAYS: 7, // order-up-to horizon beyond lead time
} as const;

// ---------- Domain ----------
export interface Product {
  sku: string;
  name: string; // e.g. "Xi măng PCB40 (bao 50kg)"
  unit: string; // "bao", "cây", "m3"...
  on_hand: number;
  on_order: number; // qty in executed-but-not-received POs
  avg_daily_demand: number;
  safety_stock: number;
  reference_price: number; // VND per unit, used for price sanity checks
}

export interface Supplier {
  id: string;
  name: string;
  approved: boolean; // only approved suppliers can ever be executed against
}

export interface SupplierOffer {
  supplier_id: string;
  sku: string;
  unit_price: number;
  moq: number;
  lead_time_days: number;
  note: string; // free text from the supplier — UNTRUSTED (prompt-injection vector in the demo)
}

// Deterministic output of server/src/replenish.ts — the LLM only explains it.
export interface Recommendation {
  sku: string;
  reorder_point: number; // avg_daily_demand × lead_time + safety_stock
  projected: number; // on_hand + on_order
  recommended_qty: number; // 0 when projected > reorder_point
  status: 'stockout_risk' | 'ok' | 'overstock';
}

export type PoStatus =
  | 'draft'
  | 'executed' // passed policy (or quorum) and sent to the simulated supplier
  | 'blocked' // hard violation, cannot be approved (e.g. unapproved supplier)
  | 'pending_approval' // over agent authority -> IGA change request open
  | 'approved' // quorum committed; waiting for the planner to re-submit
  | 'rejected'; // approvers denied

export interface PolicyCheck {
  rule: 'role' | 'supplier_approved' | 'po_limit' | 'daily_limit' | 'price_sanity' | 'qty_sanity' | 'quorum';
  ok: boolean;
  detail: string;
}

export interface PurchaseOrder {
  id: string;
  sku: string;
  supplier_id: string;
  qty: number;
  unit_price: number;
  total: number;
  status: PoStatus;
  created_by: string; // actor label, e.g. "agent-planner" — never a human's raw sub
  justification: string; // LLM text, shown but never trusted
  checks: PolicyCheck[]; // last policy evaluation
  change_request_id: string | null;
  exception_report: ExceptionReport | null;
  created_at: number;
  updated_at: number;
}

export interface ExceptionReport {
  summary: string;
  risk_flags: string[]; // e.g. ["unapproved_supplier", "possible_prompt_injection"]
  recommendation: 'approve' | 'reject' | 'investigate';
}

export interface AuditEntry {
  seq: number;
  actor: string;
  action: string;
  target: string | null;
  ts: number;
  hash: string;
}

export interface ChangeRequest {
  id: string;
  status: string; // raw IGA status: PENDING | APPROVED | DENIED | COMMITTED
  summary: string;
  approvals: number;
  required: number;
  updated_at: number;
}

// ---------- SSE /api/stream ----------
export type StreamEvent =
  | { type: 'inventory.updated'; products: Product[] }
  | { type: 'po.updated'; po: PurchaseOrder }
  | { type: 'agent.log'; agent: AgentName; step: string; message: string; ts: number }
  | { type: 'cr.updated'; id: string; status: string; approvals: number; required: number; po_id: string | null }
  | { type: 'heartbeat'; ts: number };

// ---------- REST /api/* ----------
export interface ApiError { error: string; code?: string }

// GET /api/me
export interface MeRes { actor: string; roles: string[]; permissions: Permission[] }

// GET /api/inventory            (inventory:read)
export interface InventoryRes { products: Product[]; recommendations: Recommendation[] }

// GET /api/suppliers?sku=       (supplier:read)
export interface SuppliersRes { suppliers: Supplier[]; offers: SupplierOffer[] }

// POST /api/po                  (po:draft) -> 201 PurchaseOrder (status draft)
export interface PoDraftReq { sku: string; supplier_id: string; qty: number; justification: string }

// POST /api/po/:id/submit       (po:submit) -> 200 PurchaseOrder
//   executed | blocked | pending_approval (server opened an IGA CR) | executed after approval
// GET  /api/po?status=          (po:read) -> { items: PurchaseOrder[] }
export interface PoListRes { items: PurchaseOrder[] }

// POST /api/po/:id/exception-report (exception:report) body ExceptionReport -> 200 PurchaseOrder

// POST /api/agents/run          (agents:run) -> 202 { run_id } ; progress via agent.log events
export interface AgentsRunRes { run_id: string }

// POST /api/demo/inject         (demo:inject) body { enabled: boolean } -> 200
//   enabled=true writes a malicious note into the unapproved supplier's offer.

// GET /api/audit                (audit:read) -> { items: AuditEntry[]; valid: boolean }
export interface AuditRes { items: AuditEntry[]; valid: boolean }

// GET /api/change-requests      (APPROVER role) -> read-only mirror of IGA
export interface ChangeRequestsRes { items: ChangeRequest[] }
