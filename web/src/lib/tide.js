// Tide client-side crypto helpers (track B). `tc` = the useTideCloak() context value.
// SDK shapes (@tidecloak/js IAMService.d.ts): doEncrypt([{data, tags}]) / doDecrypt([{encrypted, tags}])
// -> Promise<(string|Uint8Array)[]>. React context: forceRefreshToken(), getToken().

const TAG = "kyc";
const B64 = "b64:";

function toBase64(u8) {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return B64 + btoa(s);
}

function fromStored(ct) {
  if (typeof ct === "string" && ct.startsWith(B64)) {
    return Uint8Array.from(atob(ct.slice(B64.length)), (c) => c.charCodeAt(0));
  }
  return ct;
}

function asText(v) {
  return typeof v === "string" ? v : new TextDecoder().decode(v);
}

const now = () => (globalThis.performance?.now ? performance.now() : Date.now());

// Fire-and-forget telemetry. Never throws, never awaited by callers (DESIGN §9.1).
export function beacon(token, body) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const p = fetch("/api/telemetry/decrypt", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* telemetry must never break the UI */
  }
  return undefined;
}

export async function encryptKyc(tc, obj) {
  const res = await tc.doEncrypt([{ data: JSON.stringify(obj), tags: [TAG] }]);
  if (!Array.isArray(res) || res.length !== 1) throw new Error("doEncrypt trả về kết quả không hợp lệ");
  return typeof res[0] === "string" ? res[0] : toBase64(res[0]);
}

async function freshToken(tc) {
  // D8: refresh before each decrypt so a revoked role takes effect immediately.
  if (tc.forceRefreshToken) await tc.forceRefreshToken();
  else if (tc.refreshToken) await tc.refreshToken();
  else if (tc.updateToken) await tc.updateToken(-1);
  return (tc.getToken ? await tc.getToken() : null) || tc.token || null;
}

// D6: one doDecrypt call for N ciphertexts; beacon carries count=N.
export async function decryptMany(tc, cts) {
  const count = cts.length;
  let token = tc.token || null;
  const t0 = now();
  try {
    token = (await freshToken(tc)) || token;
    const start = now();
    const res = await tc.doDecrypt(cts.map((ct) => ({ encrypted: fromStored(ct), tags: [TAG] })));
    const latency_ms = Math.round(now() - start);
    if (!Array.isArray(res) || res.length !== count) {
      throw new Error("doDecrypt trả về kết quả không hợp lệ");
    }
    const out = res.map((v) => JSON.parse(asText(v)));
    beacon(token, { tag: TAG, ok: true, latency_ms, count });
    return out;
  } catch (err) {
    beacon(token, { tag: TAG, ok: false, latency_ms: Math.round(now() - t0), count });
    throw err;
  }
}

// "Nguyen Van A", "0912345123" -> "Nguyen V. A · 09***123"
export function maskDisplay(name, phone) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  let n;
  if (words.length === 0) n = "?";
  else if (words.length <= 2) n = words.join(" ");
  else n = [words[0], ...words.slice(1, -1).map((w) => `${w[0]}.`), words[words.length - 1]].join(" ");
  const digits = String(phone || "").replace(/\D/g, "");
  const p = digits.length >= 6 ? `${digits.slice(0, 2)}***${digits.slice(-3)}` : "***";
  return `${n} · ${p}`;
}
