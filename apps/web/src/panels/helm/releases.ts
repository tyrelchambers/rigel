import { groupReleases, type HelmRelease, type ReleaseSecret } from "@rigel/k8s/src/helm";
import { format } from "date-fns";

/** Derive Helm releases from a list of the store's secret objects. */
export function releasesFromSecrets(secrets: unknown[]): HelmRelease[] {
  return groupReleases(secrets as ReleaseSecret[]);
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
  // en-US output is intentional and consistent with the rest of the app (no i18n).
  return format(d, "MMM d, yyyy, h:mm a");
}
