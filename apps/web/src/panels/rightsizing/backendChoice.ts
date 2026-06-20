// Per-kubectl-context persistence of the right-sizing data source, mirroring
// Swift's SessionStore.metricsBackend(for:). Stored in localStorage like the
// self-host defaults (settings/useSettings.ts).
//
// "auto"       — let the server pick the best detected backend (default).
// "prometheus" — a specific detected Prometheus/VictoriaMetrics endpoint.
//
// Right-sizing reads only from a real metrics DB; there is no in-session local
// mode. When none is detected the panel prompts to install one.

export interface BackendRef {
  namespace: string;
  service: string;
  port: number;
  flavor: string;
}

export type BackendChoice = { kind: "auto" } | ({ kind: "prometheus" } & BackendRef);

export function metricsBackendKey(context: string): string {
  return `rigel_metrics_backend_${context}`;
}

export function loadBackendChoice(context: string): BackendChoice {
  try {
    const raw = localStorage.getItem(metricsBackendKey(context));
    if (!raw) return { kind: "auto" };
    const parsed = JSON.parse(raw) as BackendChoice;
    if (
      parsed?.kind === "prometheus" &&
      typeof parsed.namespace === "string" &&
      typeof parsed.service === "string" &&
      typeof parsed.port === "number"
    ) {
      return parsed;
    }
    // "auto", a legacy "local", or anything malformed → auto.
    return { kind: "auto" };
  } catch {
    return { kind: "auto" };
  }
}

export function saveBackendChoice(context: string, choice: BackendChoice): void {
  localStorage.setItem(metricsBackendKey(context), JSON.stringify(choice));
}

/** Stable <select> value for a choice; auto resolves to the server-picked backend. */
export function choiceSelectValue(choice: BackendChoice, autoResolved: BackendRef | null): string {
  if (choice.kind === "prometheus") return backendValue(choice);
  return autoResolved ? backendValue(autoResolved) : "";
}

/** Encode a backend as a <select> option value. */
export function backendValue(b: BackendRef): string {
  return `prom:${b.namespace}/${b.service}:${b.port}`;
}
