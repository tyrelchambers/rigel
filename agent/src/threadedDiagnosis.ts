/**
 * Pure, dependency-injected core for a threaded read-only Signal diagnosis:
 * resume the sender's recent `claude` session when one is live, self-heal by
 * starting fresh if that resume fails, and remember the resulting session so a
 * follow-up text within the hour continues the same thread. All IO (the model
 * call, logging) is injected so this logic is unit-testable; `index.ts` wires
 * the real implementations. Mirrors the pure-core/IO-injection split used by
 * signalInbound.ts.
 */
import type { SessionStore } from "./sessionStore.js";
import type { DiagnosisOutput } from "./diagnose.js";

export interface ThreadedDiagnosisDeps {
  /** Per-sender session pointers (1-hour idle TTL). */
  sessions: SessionStore;
  /** Run a read-only diagnosis; resumeSessionId continues a prior thread. */
  diagnose(question: string, resumeSessionId?: string): Promise<DiagnosisOutput>;
  log?(msg: string): void;
}

/**
 * Answer one inbound diagnosis question, threaded for `source`. `timestamp` (the
 * inbound Signal message time, ms) is the clock for both the idle-TTL lookup and
 * the recorded activity, so this stays pure. A failed resume is treated as a
 * stale session: clear it and answer fresh. A failure with no session to resume
 * is a real failure and propagates to the caller (which turns it into an error
 * reply).
 */
export async function runThreadedDiagnosis(
  deps: ThreadedDiagnosisDeps,
  source: string,
  timestamp: number,
  question: string,
): Promise<string> {
  const resumeId = deps.sessions.resumeIdFor(source, timestamp);
  let out: DiagnosisOutput;
  try {
    out = await deps.diagnose(question, resumeId);
  } catch (e) {
    if (!resumeId) throw e; // a fresh call already failed — nothing to retry
    // Stale/cleaned-up session: forget it (so a second failure leaves no stale
    // pointer) and answer as a brand-new thread.
    deps.log?.(`signal: resume failed for ${source}, starting fresh: ${String(e)}`);
    deps.sessions.clear(source);
    out = await deps.diagnose(question);
  }
  deps.sessions.record(source, out.sessionId, timestamp);
  return out.text || "I couldn't find anything conclusive — try asking more specifically.";
}
