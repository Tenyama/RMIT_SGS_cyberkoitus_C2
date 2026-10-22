// SSE client for GET /api/stream. EventSource has no headers, so auth goes in the query:
// real mode ?access_token=<jwt>; dev mode ?dev_sub=&dev_roles= (CONTRACTS D8).
// openStream(token, onEvent, onStatus?) -> close()
// `token` may be a string or a getter returning string|null|Promise (reconnects pick up a refreshed token).
import { DEV } from "./api.js";

const TYPES = ["inventory.updated", "po.updated", "agent.log", "cr.updated", "heartbeat"];

export function streamUrl(token, dev = DEV) {
  const q = new URLSearchParams();
  if (dev) {
    q.set("dev_sub", dev.sub);
    q.set("dev_roles", dev.roles.join(","));
  } else if (token) {
    q.set("access_token", token);
  }
  const s = q.toString();
  return "/api/stream" + (s ? `?${s}` : "");
}

export function openStream(token, onEvent, onStatus = () => {}) {
  let es = null;
  let closed = false;
  let retry = 1000;
  let timer = null;

  const handle = (name) => (msg) => {
    try {
      const ev = JSON.parse(msg.data);
      if (!ev.type && name) ev.type = name;
      onEvent(ev);
    } catch {
      /* ignore malformed frame */
    }
  };

  async function connect() {
    if (closed) return;
    let t = null;
    try { t = typeof token === "function" ? await token() : token; } catch { t = null; }
    if (closed) return;
    es = new EventSource(streamUrl(t));
    es.onopen = () => { retry = 1000; onStatus("open"); };
    es.onmessage = handle(null); // unnamed events
    for (const n of TYPES) es.addEventListener(n, handle(n)); // named events (`event: <type>`)
    es.onerror = () => {
      onStatus("error");
      // Browser retries on its own unless the stream is CLOSED (e.g. 401/403); then back off and reopen.
      if (es.readyState === EventSource.CLOSED && !closed) {
        es.close();
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      }
    };
  }

  connect();
  return function close() {
    closed = true;
    clearTimeout(timer);
    if (es) es.close();
    onStatus("closed");
  };
}
