import { describe, expect, it } from "vitest";
import { chartPrefillToFields } from "./installPrefill";

describe("chartPrefillToFields", () => {
  it("maps a repo source to repo-mode fields", () => {
    const f = chartPrefillToFields({
      source: { kind: "repo", repoName: "grafana", repoURL: "https://grafana.github.io/helm-charts", chart: "loki", version: "5.0.0" },
      version: "5.0.0",
      suggestedName: "loki",
    });
    expect(f).toEqual({
      mode: "repo",
      repoName: "grafana",
      repoURL: "https://grafana.github.io/helm-charts",
      chart: "loki",
      ociRef: "",
      localPath: "",
      version: "5.0.0",
      releaseName: "loki",
    });
  });

  it("maps an oci source to oci-mode fields", () => {
    const f = chartPrefillToFields({
      source: { kind: "oci", ref: "oci://r/bitnamicharts/postgresql", version: "16.0.0" },
      version: "16.0.0",
      suggestedName: "postgresql",
    });
    expect(f).toMatchObject({ mode: "oci", ociRef: "oci://r/bitnamicharts/postgresql", repoName: "", version: "16.0.0", releaseName: "postgresql" });
  });

  it("defaults version to empty string when null", () => {
    const f = chartPrefillToFields({
      source: { kind: "repo", repoName: "r", repoURL: "u", chart: "c", version: null },
      version: null,
      suggestedName: "c",
    });
    expect(f.version).toBe("");
  });
});
