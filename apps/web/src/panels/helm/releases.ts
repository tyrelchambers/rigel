import { groupReleases, type HelmRelease, type ReleaseSecret } from "@rigel/k8s/src/helm";

/** Derive Helm releases from the store's `resources["secrets"]` map. */
export function releasesFromSecretsMap(secrets: Record<string, unknown>): HelmRelease[] {
  return groupReleases(Object.values(secrets) as ReleaseSecret[]);
}

export type StatusTone = "green" | "yellow" | "red" | "neutral";

/** Map a Helm release status to a status-dot color tone. */
export function releaseStatusTone(status: string): StatusTone {
  const s = status.toLowerCase();
  if (s === "deployed") return "green";
  if (s === "failed") return "red";
  if (s.startsWith("pending") || s === "uninstalling") return "yellow";
  return "neutral"; // superseded, uninstalled, unknown
}

/** Format a Helm release timestamp for display; passes through unparseable input. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
