// Thin fetch wrapper for the app API (vite proxies /api -> :4000).
// Real mode: Authorization: Bearer <tide token>.
// Dev mode (VITE_DEV_ROLES set): X-Dev-Sub / X-Dev-Roles headers, no Tide login (CONTRACTS D8).

const ENV = import.meta.env || {};

// -> { sub, roles } when dev mode is on, else null.
export function devIdentity(env = ENV) {
  const roles = String(env.VITE_DEV_ROLES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!roles.length) return null;
  return { sub: env.VITE_DEV_SUB || "staff1", roles };
}

export const DEV = devIdentity();

export function buildHeaders({ token, hasBody = false, dev = DEV } = {}) {
  const headers = { Accept: "application/json" };
  if (hasBody) headers["Content-Type"] = "application/json";
  if (dev) {
    headers["X-Dev-Sub"] = dev.sub;
    headers["X-Dev-Roles"] = dev.roles.join(",");
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function api(path, { method = "GET", body, token, dev = DEV } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: buildHeaders({ token, hasBody: body !== undefined, dev }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const msg = (data && typeof data === "object" && data.error) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = data && typeof data === "object" ? data.code : undefined;
    err.body = data;
    throw err;
  }
  return data;
}

// -> MeRes { actor, roles, permissions }
export const getMe = (token) => api("/me", { token });
