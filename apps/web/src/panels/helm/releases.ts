import { groupReleases, type HelmRelease, type ReleaseSecret } from "@rigel/k8s/src/helm";

/** Derive Helm releases from the store's `resources["secrets"]` map. */
export function releasesFromSecretsMap(secrets: Record<string, unknown>): HelmRelease[] {
  return groupReleases(Object.values(secrets) as ReleaseSecret[]);
}
