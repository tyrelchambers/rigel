/**
 * Deepgram's nova-3 accepts at most 100 keyterms and recommends 20-50; past
 * that, force-fitting rises and the terms eat the 500-token prompt budget.
 * 50 total keeps roughly half the list free for live cluster names.
 */
export const MAX_KEYTERMS = 50;

/** Anything longer is a generated pod suffix nobody says out loud. */
export const MAX_KEYTERM_LENGTH = 40;

export const CONFIRM_KEYTERMS = [
  "confirm",
  "cancel",
  "abort",
  "stop",
  "wait",
  "never mind",
  "don't",
  "no",
];

export const KUBERNETES_KEYTERMS = [
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "OOMKilled",
  "Evicted",
  "NotReady",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "CronJob",
  "ConfigMap",
  "Ingress",
  "PersistentVolumeClaim",
  "PodDisruptionBudget",
  "HorizontalPodAutoscaler",
  "kubectl",
  "kube-system",
];

export const STATIC_KEYTERMS = [...CONFIRM_KEYTERMS, ...KUBERNETES_KEYTERMS];

/** Static terms first, then live cluster names, deduped and capped. */
export function buildKeyterms(resourceNames: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...STATIC_KEYTERMS, ...resourceNames]) {
    const term = raw.trim();
    if (!term || term.length > MAX_KEYTERM_LENGTH) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === MAX_KEYTERMS) break;
  }
  return out;
}

export function sameKeyterms(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
