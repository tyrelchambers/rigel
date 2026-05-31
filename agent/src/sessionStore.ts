/**
 * Per-sender pointer to the operator's current `claude` CLI diagnosis session,
 * so a burst of related Signal texts threads as one conversation and then
 * quietly evaporates. In-memory and ephemeral by design: a pod restart is a
 * clean slate, which matches the CLI's transcript also being ephemeral. The
 * thread auto-resets after an hour of silence; there is no explicit reset
 * command. Driven by the inbound message's own timestamp as "now", so the logic
 * is pure and clock-free — mirroring SeenTimestamps in signalInbound.ts.
 */
import { normalizeNumber } from "./signalInbound.js";

export const ONE_HOUR_MS = 3_600_000;

interface Entry {
  sessionId: string;
  lastActivityMs: number;
}

export class SessionStore {
  private readonly byNumber = new Map<string, Entry>();
  constructor(private readonly ttlMs = ONE_HOUR_MS) {}

  /** The session to resume for `source` if its last activity was within the TTL;
   * otherwise evict the stale entry and return undefined (→ start fresh). */
  resumeIdFor(source: string, nowMs: number): string | undefined {
    const key = normalizeNumber(source);
    const e = this.byNumber.get(key);
    if (!e) return undefined;
    if (nowMs - e.lastActivityMs > this.ttlMs) {
      this.byNumber.delete(key);
      return undefined;
    }
    return e.sessionId;
  }

  /** Remember `sessionId` as `source`'s active thread, stamped at `nowMs`.
   * A blank id is ignored so we never resume a non-existent session. */
  record(source: string, sessionId: string, nowMs: number): void {
    if (!sessionId) return;
    this.byNumber.set(normalizeNumber(source), { sessionId, lastActivityMs: nowMs });
  }

  /** Forget `source`'s thread (used when a resume fails). */
  clear(source: string): void {
    this.byNumber.delete(normalizeNumber(source));
  }
}
