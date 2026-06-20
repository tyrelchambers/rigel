// Pure wizard logic — gating, template-var assembly, secret pre-fill, and pod
// readiness. Kept separate from the React components so it can be unit-tested
// (docs/parity/catalog.md §"Install Wizard Flow").
import {
  generateSecret,
  substitute,
  substitutePlaceholders,
  scanPlaceholders,
  type CatalogApp,
  type SecretFieldSpec,
} from "@rigel/catalog";
import type { Pod } from "../pods/types";

export type WizardStep =
  | "configure"
  | "generating"
  | "secrets"
  | "review"
  | "applying"
  | "verifying"
  | "done"
  | "failed";

export interface ConfigureValues {
  instance: string;
  namespace: string;
  hostname: string;
  nodePin: string | null;
  storageGiB: number;
  clusterIssuer: string;
  notes: string;
}

/**
 * Namespace options for the Configure-step dropdown — every cluster namespace,
 * sorted, plus the current selection seeded at the top if the watch hasn't
 * surfaced it yet, so the picker can always represent the chosen value. Mirrors
 * the Swift `CatalogInstallWizardModel.namespaceOptions`. The web UI renders
 * these in a real <select> (NOT an <input list> datalist — a datalist filters
 * its suggestions by the field's current text, which made "default" hide every
 * namespace except the ones containing that substring).
 */
export function namespaceOptions(namespaces: string[], current: string): string[] {
  const opts = [...namespaces].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  const cur = current.trim();
  if (cur !== "" && !opts.includes(cur)) opts.unshift(cur);
  return opts;
}

/** Configure-step gate (docs/parity/catalog.md §"Step 1: Configure"). */
export function canAdvanceFromConfigure(app: CatalogApp, v: ConfigureValues): boolean {
  if (v.instance.trim() === "") return false;
  if (v.namespace.trim() === "") return false;
  if (app.exposesIngress && v.hostname.trim() === "") return false;
  if (app.persistence && v.storageGiB <= 0) return false;
  return true;
}

/** Assemble the documented template variables from Configure values. */
export function templateVars(v: ConfigureValues): Record<string, string> {
  return {
    instance: v.instance,
    namespace: v.namespace,
    hostname: v.hostname,
    nodeName: v.nodePin ?? "",
    storage: String(v.storageGiB),
    clusterIssuer: v.clusterIssuer,
    redirectMiddleware: `${v.instance}-redirect`,
    notes: v.notes,
  };
}

/** The baked artifact for an app (manifest or helm values), substituted. nil if not baked. */
export function renderArtifact(
  app: CatalogApp,
  vars: Record<string, string>,
): string | null {
  const raw = app.install?.manifest ?? app.install?.values ?? null;
  if (raw == null) return null;
  return substitute(raw, vars);
}

/**
 * Resolve the SecretFieldSpec list for a baked artifact: the authoritative
 * `install.secrets` if present, otherwise a synthesized user-field spec per
 * scanned placeholder so the Secrets step still renders.
 */
export function resolveSecretSpecs(
  app: CatalogApp,
  artifact: string,
): SecretFieldSpec[] {
  const declared = app.install?.secrets;
  if (declared && declared.length > 0) return declared;
  return scanPlaceholders(artifact).map((p) => ({
    key: p.key,
    label: p.key,
    kind: "user" as const,
    required: true,
  }));
}

/** Initial secret values: random fields pre-generated, user fields empty. */
export function initialSecretValues(specs: SecretFieldSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of specs) {
    out[s.key] =
      s.kind === "random"
        ? generateSecret(s.length ?? 32, s.format ?? "alphanumeric")
        : "";
  }
  return out;
}

/** True when every required user field has a non-empty value. */
export function secretsComplete(
  specs: SecretFieldSpec[],
  values: Record<string, string>,
): boolean {
  return specs.every((s) => {
    const required = s.required ?? true;
    if (!required) return true;
    return (values[s.key] ?? "").trim() !== "";
  });
}

/** Fold collected secret values into the artifact. Mirrors PlaceholderScanner.substitute. */
export function fillSecrets(
  artifact: string,
  values: Record<string, string>,
): string {
  return substitutePlaceholders(artifact, values);
}

// --- Verifying: pod readiness ----------------------------------------------

export type PodVerifyState = "creating" | "starting" | "ready" | "failed";

export interface PodReadiness {
  /** "creating": no pods yet. "starting": some not ready. "ready": all ready. "failed": a pod failed. */
  state: PodVerifyState;
  ready: number;
  total: number;
  /** Highest restart count seen across matched pods (for ≥3 hand-off). */
  maxRestarts: number;
}

/** Pods matching the install: same namespace + label app.kubernetes.io/instance=instance. */
export function matchInstancePods(
  pods: Pod[],
  namespace: string,
  instance: string,
): Pod[] {
  return pods.filter(
    (p) =>
      (p.metadata.namespace ?? "default") === namespace &&
      p.metadata.labels?.["app.kubernetes.io/instance"] === instance,
  );
}

/** A pod is Ready when phase=Running and every container status reports ready. */
function podIsReady(p: Pod): boolean {
  if (p.status?.phase !== "Running") return false;
  const cs = p.status?.containerStatuses ?? [];
  if (cs.length === 0) return false;
  return cs.every((c) => c.ready);
}

/** A pod is failed when its phase is Failed, or a container is in a crash/error waiting reason. */
function podIsFailed(p: Pod): boolean {
  if (p.status?.phase === "Failed") return true;
  for (const c of p.status?.containerStatuses ?? []) {
    const reason = c.state?.waiting?.reason ?? "";
    if (reason === "CrashLoopBackOff" || reason === "ImagePullBackOff" || reason === "ErrImagePull") {
      return true;
    }
  }
  return false;
}

/** Summarize readiness across the matched pods. */
export function podReadiness(pods: Pod[]): PodReadiness {
  const total = pods.length;
  if (total === 0) return { state: "creating", ready: 0, total: 0, maxRestarts: 0 };

  let ready = 0;
  let failed = false;
  let maxRestarts = 0;
  for (const p of pods) {
    if (podIsReady(p)) ready++;
    if (podIsFailed(p)) failed = true;
    for (const c of p.status?.containerStatuses ?? []) {
      if (c.restartCount > maxRestarts) maxRestarts = c.restartCount;
    }
  }

  let state: PodVerifyState;
  if (failed) state = "failed";
  else if (ready === total) state = "ready";
  else state = "starting";

  return { state, ready, total, maxRestarts };
}
