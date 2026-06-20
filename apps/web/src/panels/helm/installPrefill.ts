import type { HelmChartSource } from "@rigel/k8s/src/helm";

export type InstallMode = "repo" | "oci" | "local";

/** A chart chosen in the Browse view, to seed the Install form. */
export interface ChartPrefill {
  source: HelmChartSource;
  version: string | null;
  suggestedName: string;
}

/** Flat field values the Install form applies when a chart is prefilled. */
export interface PrefillFields {
  mode: InstallMode;
  repoName: string;
  repoURL: string;
  chart: string;
  ociRef: string;
  localPath: string;
  version: string;
  releaseName: string;
}

/** Convert a chart prefill into the Install form's flat field values. */
export function chartPrefillToFields(p: ChartPrefill): PrefillFields {
  const base = { repoName: "", repoURL: "", chart: "", ociRef: "", localPath: "", version: p.version ?? "", releaseName: p.suggestedName };
  switch (p.source.kind) {
    case "oci":
      return { ...base, mode: "oci", ociRef: p.source.ref };
    case "local":
      return { ...base, mode: "local", localPath: p.source.path };
    case "repo":
    default:
      return { ...base, mode: "repo", repoName: p.source.repoName, repoURL: p.source.repoURL, chart: p.source.chart };
  }
}
