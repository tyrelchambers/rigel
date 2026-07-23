/**
 * A key → `claude` CLI session pointer, used to thread a conversation. Two
 * instances exist: the Signal store (1-hour idle TTL, phone-number-normalized
 * keys, in-memory) and the Matrix store (no expiry, opaque room-id keys,
 * persisted to the state ConfigMap so a topic room survives pod restarts).
 * `normalizeKey` and `ttlMs` are injected so one class serves both. Pure and
 * clock-free: "now" is always passed in.
 */
export const ONE_HOUR_MS = 3_600_000;

interface Entry {
  sessionId: string;
  lastActivityMs: number;
}

export class SessionStore {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly ttlMs = ONE_HOUR_MS,
    private readonly normalizeKey: (s: string) => string = (s) => s,
  ) {}

  /** The session to resume for `key` if its last activity was within the TTL;
   * otherwise evict the stale entry and return undefined (→ start fresh). With
   * an infinite TTL nothing is ever evicted. */
  resumeIdFor(key: string, nowMs: number): string | undefined {
    const k = this.normalizeKey(key);
    const e = this.entries.get(k);
    if (!e) return undefined;
    if (nowMs - e.lastActivityMs > this.ttlMs) {
      this.entries.delete(k);
      return undefined;
    }
    return e.sessionId;
  }

  /** Remember `sessionId` as `key`'s active thread, stamped at `nowMs`. A blank
   * id is ignored so we never resume a non-existent session. */
  record(key: string, sessionId: string, nowMs: number): void {
    if (!sessionId) return;
    this.entries.set(this.normalizeKey(key), { sessionId, lastActivityMs: nowMs });
  }

  /** Forget `key`'s thread (used on `/reset` and when a resume fails). */
  clear(key: string): void {
    this.entries.delete(this.normalizeKey(key));
  }

  /** A `key → sessionId` snapshot for persistence to the state ConfigMap. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, e] of this.entries) out[k] = e.sessionId;
    return out;
  }

  /** Rehydrate from a persisted snapshot, stamping each entry as active at
   * `nowMs`. Blank ids and a missing snapshot are ignored. */
  load(snapshot: Record<string, string> | undefined, nowMs: number): void {
    if (!snapshot) return;
    for (const [k, id] of Object.entries(snapshot)) {
      if (id) this.entries.set(k, { sessionId: id, lastActivityMs: nowMs });
    }
  }
}
