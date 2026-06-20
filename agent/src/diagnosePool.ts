/**
 * Stage A of the autonomous loop: investigate every confirmed incident
 * concurrently (bounded), independent of the serial decide/execute pass that
 * follows. The Worker (model) call is the slow, per-incident, side-effect-free
 * part — overlapping those calls cuts wall-clock when several incidents are
 * confirmed in one tick, while the deterministic guardrails (circuit breaker,
 * audit log) all stay in the serial Stage B in `index.ts`.
 *
 * All IO (the diagnosis call) is injected so this is unit-testable; `index.ts`
 * wires the real `runWorker`. Mirrors the pure-core/IO-injection split used by
 * threadedDiagnosis.ts.
 */
import { mapPool } from "./pool.js";
import type { SuggestedAction } from "./action.js";
import type { Incident } from "./detector.js";

/** One Stage-A result per confirmed incident, returned in input order. */
export interface DiagnosisPacket {
  incident: Incident;
  analysis: string;
  actions: SuggestedAction[];
  /** Worker call threw — Stage B records a fail-closed failure (and detects
   * auth lapses). */
  error?: string;
}

export interface DiagnoseDeps {
  /** Investigate one incident (the Worker model call). */
  diagnose(incident: Incident): Promise<{ analysis: string; actions: SuggestedAction[]; costUsd: number }>;
  /** Max diagnoses in flight at once. */
  limit: number;
}

/**
 * Diagnose every incident, at most `deps.limit` at a time, returning one packet
 * per incident IN INPUT ORDER so Stage B's execution and audit log stay
 * deterministic regardless of which diagnosis finished first.
 */
export async function diagnoseConfirmed(
  deps: DiagnoseDeps,
  incidents: readonly Incident[],
): Promise<DiagnosisPacket[]> {
  return mapPool(incidents, deps.limit, async (incident): Promise<DiagnosisPacket> => {
    try {
      const out = await deps.diagnose(incident);
      return { incident, analysis: out.analysis, actions: out.actions };
    } catch (e) {
      return { incident, analysis: "", actions: [], error: String(e) };
    }
  });
}
