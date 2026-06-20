import { test, expect } from "vitest";
import { parseArtifactHubResults, type ArtifactHubChart } from "./artifactHub";

const SAMPLE = {
  packages: [
    {
      name: "cert-manager",
      version: "1.14.0",
      description: "A Helm chart for cert-manager",
      logo_image_id: "abc",
      repository: { name: "jetstack", url: "https://charts.jetstack.io" },
    },
    {
      name: "postgresql",
      version: "16.0.0",
      description: "PostgreSQL chart",
      repository: { name: "bitnami", url: "oci://registry-1.docker.io/bitnamicharts" },
    },
  ],
};

test("parseArtifactHubResults maps repo vs oci sources", () => {
  const out: ArtifactHubChart[] = parseArtifactHubResults(SAMPLE);
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({
    name: "cert-manager",
    version: "1.14.0",
    repoName: "jetstack",
    source: { kind: "repo", repoName: "jetstack", repoURL: "https://charts.jetstack.io", chart: "cert-manager", version: "1.14.0" },
  });
  expect(out[1].source).toEqual({
    kind: "oci",
    ref: "oci://registry-1.docker.io/bitnamicharts/postgresql",
    version: "16.0.0",
  });
});

test("parseArtifactHubResults tolerates a missing packages array", () => {
  expect(parseArtifactHubResults({})).toEqual([]);
  expect(parseArtifactHubResults(null)).toEqual([]);
});
