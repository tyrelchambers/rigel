import { afterEach, test, expect, vi } from "vitest";
import { parseArtifactHubResults, buildArtifactHubSearchURL, browseArtifactHub, type ArtifactHubChart } from "./artifactHub";

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
    displayName: "cert-manager",
    version: "1.14.0",
    repoName: "jetstack",
    logoURL: "https://artifacthub.io/image/abc",
    stars: 0,
    official: false,
    verifiedPublisher: false,
    source: { kind: "repo", repoName: "jetstack", repoURL: "https://charts.jetstack.io", chart: "cert-manager", version: "1.14.0" },
  });
  expect(out[1].logoURL).toBeNull();
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

test("buildArtifactHubSearchURL sorts by stars and omits ts_query_web when no query", () => {
  const u = new URL(buildArtifactHubSearchURL({}));
  expect(u.searchParams.get("kind")).toBe("0");
  expect(u.searchParams.get("sort")).toBe("stars");
  expect(u.searchParams.has("ts_query_web")).toBe(false);
  expect(u.searchParams.get("limit")).toBe("24");
  expect(u.searchParams.get("offset")).toBe("0");
});

test("buildArtifactHubSearchURL uses relevance + ts_query_web when a query is present", () => {
  const u = new URL(buildArtifactHubSearchURL({ query: "loki" }));
  expect(u.searchParams.get("sort")).toBe("relevance");
  expect(u.searchParams.get("ts_query_web")).toBe("loki");
});

test("buildArtifactHubSearchURL adds flags only when true and clamps limit to 60", () => {
  const u = new URL(buildArtifactHubSearchURL({ official: true, verified: false, limit: 1000, offset: 48 }));
  expect(u.searchParams.get("official")).toBe("true");
  expect(u.searchParams.has("verified_publisher")).toBe(false);
  expect(u.searchParams.get("limit")).toBe("60");
  expect(u.searchParams.get("offset")).toBe("48");
});

afterEach(() => vi.unstubAllGlobals());

test("browseArtifactHub returns items and total from the Pagination header", async () => {
  const headers = new Headers({ "Pagination-Total-Count": "57" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200, headers })));
  const { items, total } = await browseArtifactHub({ query: "cert" });
  expect(total).toBe(57);
  expect(items).toHaveLength(2);
});

test("browseArtifactHub fails soft to empty on non-200", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
  expect(await browseArtifactHub({})).toEqual({ items: [], total: 0 });
});

test("parseArtifactHubResults surfaces stars and official/verified flags", () => {
  const out = parseArtifactHubResults({
    packages: [
      {
        name: "grafana",
        version: "8.0.0",
        description: "d",
        stars: 42,
        official: true,
        repository: { name: "grafana", url: "https://grafana.github.io/helm-charts", verified_publisher: true },
      },
    ],
  });
  expect(out[0]).toMatchObject({ official: true, verifiedPublisher: true, stars: 42 });
});

test("parseArtifactHubResults treats repository.official as official", () => {
  const out = parseArtifactHubResults({
    packages: [{ name: "x", version: "1", repository: { name: "r", url: "https://r", official: true } }],
  });
  expect(out[0].official).toBe(true);
});

test("buildArtifactHubSearchURL falls back to default limit for invalid input", () => {
  const u = new URL(buildArtifactHubSearchURL({ limit: Number("nope") }));
  expect(u.searchParams.get("limit")).toBe("24");
});
