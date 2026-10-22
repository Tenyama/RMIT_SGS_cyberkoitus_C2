// Thin fetch wrapper for the app API (vite proxies /api -> :4000).

export async function api(path, { method = "GET", body, token } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
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

// -> MeRes { actor_hash, roles }
export const getMe = (token) => api("/me", { token });
