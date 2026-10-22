import { createHmac } from 'node:crypto';

/** HMAC-SHA256(sub) → hex. Raw sub never leaves this process (NFR4). */
export function actorHash(sub: string): string {
  const key = process.env.HMAC_KEY || 'dev-hmac-key';
  return createHmac('sha256', key).update(sub).digest('hex');
}

// D7: in-memory only, never persisted.
const subs = new Map<string, string>();

export function remember(hash: string, sub: string): void {
  subs.set(hash, sub);
}
export function lookupSub(hash: string): string | undefined {
  return subs.get(hash);
}
