import type { PendingLogin } from "./accountStore";
import type { PollResult } from "./accountClient";

const FAST_MS = 2_000;
const SLOW_MS = 15_000;
const FAST_WINDOW_MS = 120_000;

export interface PollLoopDeps {
  getPending(): PendingLogin | null;
  clearPending(): void;
  hasToken(): boolean;
  poll(pollToken: string): Promise<PollResult>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onSignedIn(): void;
  onEnded(): void;
}

/** Polls an in-flight device-authorization sign-in until it confirms or expires.
 *  Fast for the first two minutes, then slow, so a link opened later still lands. */
export function createPollLoop(deps: PollLoopDeps) {
  let handle: unknown = null;

  function stop(): void {
    if (handle !== null) {
      deps.clearTimer(handle);
      handle = null;
    }
  }

  function schedule(startedAt: number): void {
    const elapsed = deps.now() - startedAt;
    handle = deps.setTimer(() => void tick(), elapsed < FAST_WINDOW_MS ? FAST_MS : SLOW_MS);
  }

  async function tick(): Promise<void> {
    handle = null;
    const pending = deps.getPending();
    if (!pending) return;
    if (deps.hasToken()) {
      deps.clearPending();
      return;
    }
    if (deps.now() >= pending.expiresAt) {
      deps.clearPending();
      deps.onEnded();
      return;
    }
    const r = await deps.poll(pending.pollToken);
    if (r.status === "confirmed") {
      deps.clearPending();
      deps.onSignedIn();
      return;
    }
    if (r.status === "expired") {
      deps.clearPending();
      deps.onEnded();
      return;
    }
    schedule(pending.startedAt);
  }

  return {
    /** Begin (or restart) polling for whatever pending login is stored. */
    start(): void {
      stop();
      const pending = deps.getPending();
      if (!pending) return;
      schedule(pending.startedAt);
    },
    stop,
  };
}
