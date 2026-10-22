// SSE client for GET /api/stream (CONTRACTS: JWT via ?access_token= because EventSource has no headers).
// openStream(token, onEvent, onStatus?) -> close()
// `token` may be a string or a () => string|null getter (so reconnects pick up a refreshed token).
const TYPES = ['node.state', 'key.margin', 'alert.opened', 'alert.updated', 'cr.updated', 'decrypt.rate', 'tidecloak.health', 'heartbeat'];

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

  function connect() {
    if (closed) return;
    const t = typeof token === 'function' ? token() : token;
    es = new EventSource('/api/stream' + (t ? `?access_token=${encodeURIComponent(t)}` : ''));
    es.onopen = () => { retry = 1000; onStatus('open'); };
    es.onmessage = handle(null); // unnamed events
    for (const n of TYPES) es.addEventListener(n, handle(n)); // named events (`event: <type>`)
    es.onerror = () => {
      onStatus('error');
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
    onStatus('closed');
  };
}
