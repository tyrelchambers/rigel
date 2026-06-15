import { test, expect, describe } from "bun:test";
import { loadCatalog, CATALOG } from "./loader";
import { substitute } from "./substitute";
import { installedAppIDs, imageRepoPath, repoPathsMatch } from "./detection";
import {
  scanPlaceholders,
  substitutePlaceholders,
  hasUnfilledMarkers,
  validateManifestShape,
} from "./placeholder";
import { summarizeResources } from "./resourceSummary";
import { generateSecret } from "./randomSecret";
import { isBaked, type CatalogApp } from "./types";
import { manifestImages, unpinnedReason } from "./manifestImages";

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------
describe("loadCatalog", () => {
  test("loads 55 apps", async () => {
    const apps = await loadCatalog();
    expect(apps.length).toBe(55);
    expect(apps).toBe(CATALOG);
  });

  test("every app has the required typed fields", () => {
    for (const app of CATALOG) {
      expect(typeof app.id).toBe("string");
      expect(app.id.length).toBeGreaterThan(0);
      expect(typeof app.name).toBe("string");
      expect(typeof app.tagline).toBe("string");
      expect(typeof app.description).toBe("string");
      expect(typeof app.category).toBe("string");
      expect(typeof app.iconSystemName).toBe("string");
      expect(typeof app.docsURL).toBe("string");
      expect(Array.isArray(app.tags)).toBe(true);
      expect(Array.isArray(app.matchImages)).toBe(true);
      expect(typeof app.requirements.cpuRequest).toBe("string");
      expect(typeof app.requirements.memoryRequest).toBe("string");
      expect(typeof app.persistence).toBe("boolean");
      expect(typeof app.exposesIngress).toBe("boolean");
      expect(typeof app.installPromptTemplate).toBe("string");
    }
  });

  test("category is one of the known enum values", () => {
    const valid = new Set([
      "database",
      "observability",
      "productivity",
      "dev-tools",
      "media",
      "network",
      "other",
    ]);
    for (const app of CATALOG) expect(valid.has(app.category)).toBe(true);
  });

  test("vaultwarden is a baked manifest app", () => {
    const vw = CATALOG.find((a) => a.id === "vaultwarden");
    expect(vw).toBeDefined();
    expect(vw?.install?.mode).toBe("manifest");
    expect(isBaked(vw as CatalogApp)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// substitute
// ---------------------------------------------------------------------------
describe("substitute", () => {
  test("replaces {{instance}} with value", () => {
    expect(substitute("{{instance}}-secret", { instance: "foo" })).toBe("foo-secret");
  });

  test("replaces all occurrences", () => {
    expect(substitute("{{ns}}/{{ns}}", { ns: "apps" })).toBe("apps/apps");
  });

  test("leaves unknown variables as literal", () => {
    expect(substitute("{{instance}}-{{unknown}}", { instance: "foo" })).toBe(
      "foo-{{unknown}}",
    );
  });

  test("substitutes every documented variable", () => {
    const tpl =
      "{{instance}} {{namespace}} {{hostname}} {{nodeName}} {{storage}} {{clusterIssuer}} {{redirectMiddleware}} {{notes}}";
    const out = substitute(tpl, {
      instance: "i",
      namespace: "n",
      hostname: "h",
      nodeName: "node",
      storage: "100",
      clusterIssuer: "le",
      redirectMiddleware: "i-redirect",
      notes: "hi",
    });
    expect(out).toBe("i n h node 100 le i-redirect hi");
  });
});

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------
describe("imageRepoPath", () => {
  test("drops tag", () => {
    expect(imageRepoPath("docker.io/vaultwarden/server:latest")).toBe(
      "docker.io/vaultwarden/server",
    );
  });
  test("drops digest", () => {
    expect(imageRepoPath("ghcr.io/x/y@sha256:abc")).toBe("ghcr.io/x/y");
  });
  test("keeps registry port, drops tag", () => {
    expect(imageRepoPath("localhost:5000/app:v1")).toBe("localhost:5000/app");
  });
  test("bare image with tag", () => {
    expect(imageRepoPath("nextcloud:29-apache")).toBe("nextcloud");
  });
});

describe("repoPathsMatch", () => {
  test("host- and library/-insensitive", () => {
    expect(repoPathsMatch("docker.io/library/nextcloud", "nextcloud")).toBe(true);
    expect(repoPathsMatch("docker.io/vaultwarden/server", "vaultwarden/server")).toBe(
      true,
    );
  });
  test("does not match a different org segment", () => {
    expect(repoPathsMatch("supabase/postgres", "postgres")).toBe(false);
  });
});

describe("installedAppIDs", () => {
  test("matches apps by normalizing repo paths", () => {
    const apps: CatalogApp[] = [
      {
        id: "vaultwarden",
        name: "Vaultwarden",
        tagline: "",
        description: "",
        category: "productivity",
        iconSystemName: "lock.circle.fill",
        docsURL: "https://x",
        tags: [],
        matchImages: ["docker.io/vaultwarden/server"],
        requirements: { cpuRequest: "100m", memoryRequest: "128Mi" },
        persistence: true,
        exposesIngress: true,
        installPromptTemplate: "",
      },
      {
        id: "nextcloud",
        name: "Nextcloud",
        tagline: "",
        description: "",
        category: "productivity",
        iconSystemName: "folder.fill",
        docsURL: "https://x",
        tags: [],
        matchImages: ["nextcloud"],
        requirements: { cpuRequest: "100m", memoryRequest: "128Mi" },
        persistence: true,
        exposesIngress: true,
        installPromptTemplate: "",
      },
    ];
    const deployments = [
      { spec: { template: { spec: { containers: [{ image: "vaultwarden/server:latest" }] } } } },
    ];
    const pods = [
      { spec: { containers: [{ image: "docker.io/library/nextcloud:29" }] } },
    ];
    const ids = installedAppIDs(apps, deployments, [], [], pods);
    expect(ids.has("vaultwarden")).toBe(true);
    expect(ids.has("nextcloud")).toBe(true);
  });

  test("no match when image absent", () => {
    const apps: CatalogApp[] = [
      {
        id: "vaultwarden",
        name: "Vaultwarden",
        tagline: "",
        description: "",
        category: "productivity",
        iconSystemName: "lock.circle.fill",
        docsURL: "https://x",
        tags: [],
        matchImages: ["docker.io/vaultwarden/server"],
        requirements: { cpuRequest: "100m", memoryRequest: "128Mi" },
        persistence: true,
        exposesIngress: true,
        installPromptTemplate: "",
      },
    ];
    const ids = installedAppIDs(apps, [], [], [], [
      { spec: { containers: [{ image: "nginx:latest" }] } },
    ]);
    expect(ids.size).toBe(0);
  });

  // --- Annotation-first detection (catalog-link-workload spec) -------------
  test("annotation on a Deployment is a definitive match even with no image match", () => {
    const apps: CatalogApp[] = [
      {
        id: "foo", name: "Foo", tagline: "", description: "", category: "other",
        iconSystemName: "x", docsURL: "https://x", tags: [],
        matchImages: ["ghcr.io/foo/foo"],
        requirements: { cpuRequest: "100m", memoryRequest: "128Mi" },
        persistence: false, exposesIngress: false, installPromptTemplate: "",
      },
    ];
    const deployments = [
      {
        metadata: { name: "mirror-foo", namespace: "apps", annotations: { "helmsman.dev/catalog-app": "foo" } },
        spec: { template: { spec: { containers: [{ image: "registry.internal/team/foo:1.0" }] } } },
      },
    ];
    const ids = installedAppIDs(apps, deployments, [], [], []);
    expect(ids.has("foo")).toBe(true);
  });

  test("annotation-definitive match holds for a StatefulSet and a DaemonSet", () => {
    const apps: CatalogApp[] = [
      { id: "bar", name: "Bar", tagline: "", description: "", category: "other", iconSystemName: "x", docsURL: "https://x", tags: [], matchImages: ["ghcr.io/bar/bar"], requirements: { cpuRequest: "100m", memoryRequest: "128Mi" }, persistence: false, exposesIngress: false, installPromptTemplate: "" },
      { id: "baz", name: "Baz", tagline: "", description: "", category: "other", iconSystemName: "x", docsURL: "https://x", tags: [], matchImages: ["ghcr.io/baz/baz"], requirements: { cpuRequest: "100m", memoryRequest: "128Mi" }, persistence: false, exposesIngress: false, installPromptTemplate: "" },
    ];
    const statefulSets = [
      { metadata: { name: "bar", namespace: "db", annotations: { "helmsman.dev/catalog-app": "bar" } }, spec: { template: { spec: { containers: [{ image: "private/bar:2" }] } } } },
    ];
    const daemonSets = [
      { metadata: { name: "baz", namespace: "mon", annotations: { "helmsman.dev/catalog-app": "baz" } }, spec: { template: { spec: { containers: [{ image: "private/baz:3" }] } } } },
    ];
    const ids = installedAppIDs(apps, [], statefulSets, daemonSets, []);
    expect(ids.has("bar")).toBe(true);
    expect(ids.has("baz")).toBe(true);
  });

  test("with no annotation, detects an app whose image runs only on a DaemonSet", () => {
    const apps: CatalogApp[] = [
      { id: "node-exporter", name: "Node Exporter", tagline: "", description: "", category: "observability", iconSystemName: "x", docsURL: "https://x", tags: [], matchImages: ["quay.io/prometheus/node-exporter"], requirements: { cpuRequest: "100m", memoryRequest: "128Mi" }, persistence: false, exposesIngress: false, installPromptTemplate: "" },
    ];
    const daemonSets = [
      { metadata: { name: "node-exp", namespace: "mon" }, spec: { template: { spec: { containers: [{ image: "quay.io/prometheus/node-exporter:v1.8.0" }] } } } },
    ];
    const ids = installedAppIDs(apps, [], [], daemonSets, []);
    expect(ids.has("node-exporter")).toBe(true);
  });

  test("annotation value for an id not in the catalog does not crash detection", () => {
    const apps: CatalogApp[] = [
      { id: "real", name: "Real", tagline: "", description: "", category: "other", iconSystemName: "x", docsURL: "https://x", tags: [], matchImages: ["ghcr.io/real/real"], requirements: { cpuRequest: "100m", memoryRequest: "128Mi" }, persistence: false, exposesIngress: false, installPromptTemplate: "" },
    ];
    const deployments = [
      { metadata: { name: "mystery", namespace: "apps", annotations: { "helmsman.dev/catalog-app": "not-a-real-app" } }, spec: { template: { spec: { containers: [{ image: "x:1" }] } } } },
    ];
    expect(() => installedAppIDs(apps, deployments, [], [], [])).not.toThrow();
    const ids = installedAppIDs(apps, deployments, [], [], []);
    expect(ids.has("real")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// placeholder scanning
// ---------------------------------------------------------------------------
describe("scanPlaceholders", () => {
  test("finds <FILL_ME_IN> markers", () => {
    const yaml = [
      "apiVersion: v1",
      "kind: Secret",
      "stringData:",
      "  ADMIN_TOKEN: <FILL_ME_IN>",
    ].join("\n");
    expect(scanPlaceholders(yaml).map((p) => p.key)).toEqual(["ADMIN_TOKEN"]);
  });

  test("finds empty Secret data values but not non-empty", () => {
    const yaml = [
      "kind: Secret",
      "data:",
      '  ADMIN_PASSWORD: ""',
      '  RABBIT_DEFAULT_USER: "guest"',
      "  EMPTY:",
    ].join("\n");
    expect(scanPlaceholders(yaml).map((p) => p.key).sort()).toEqual([
      "ADMIN_PASSWORD",
      "EMPTY",
    ]);
  });

  test("ignores empty values outside Secret data blocks", () => {
    const yaml = ["kind: ConfigMap", "data:", '  KEY: ""'].join("\n");
    expect(scanPlaceholders(yaml)).toEqual([]);
  });

  test("deduplicates keys", () => {
    const yaml = [
      "kind: Secret",
      "stringData:",
      "  TOKEN: <FILL_ME_IN>",
      "---",
      "kind: Secret",
      "stringData:",
      "  TOKEN: <FILL_ME_IN>",
    ].join("\n");
    expect(scanPlaceholders(yaml).map((p) => p.key)).toEqual(["TOKEN"]);
  });
});

describe("substitutePlaceholders / hasUnfilledMarkers", () => {
  test("fills a marker and clears unfilled flag", () => {
    const yaml = ["kind: Secret", "stringData:", "  TOKEN: <FILL_ME_IN>"].join("\n");
    expect(hasUnfilledMarkers(yaml)).toBe(true);
    const filled = substitutePlaceholders(yaml, { TOKEN: "s3cr3t" });
    expect(filled).toContain("TOKEN: s3cr3t");
    expect(hasUnfilledMarkers(filled)).toBe(false);
  });

  test("fills an empty Secret value with quoted scalar", () => {
    const yaml = ["kind: Secret", "data:", '  PW: ""'].join("\n");
    const filled = substitutePlaceholders(yaml, { PW: "abc" });
    expect(filled).toContain("PW: 'abc'");
  });

  test("leaves marker literal when no value supplied", () => {
    const yaml = ["kind: Secret", "stringData:", "  TOKEN: <FILL_ME_IN>"].join("\n");
    const filled = substitutePlaceholders(yaml, {});
    expect(hasUnfilledMarkers(filled)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// manifest shape
// ---------------------------------------------------------------------------
describe("validateManifestShape", () => {
  test("returns null for valid single doc", () => {
    expect(validateManifestShape("apiVersion: v1\nkind: Service")).toBeNull();
  });

  test("returns null for valid multi-doc", () => {
    const yaml = [
      "apiVersion: v1",
      "kind: Secret",
      "---",
      "apiVersion: apps/v1",
      "kind: Deployment",
    ].join("\n");
    expect(validateManifestShape(yaml)).toBeNull();
  });

  test("rejects missing apiVersion", () => {
    const err = validateManifestShape("kind: Service");
    expect(err).not.toBeNull();
    expect(err).toContain("apiVersion");
  });

  test("rejects missing kind, names the document", () => {
    const yaml = ["apiVersion: v1\nkind: Secret", "---", "apiVersion: v1"].join("\n");
    const err = validateManifestShape(yaml);
    expect(err).toContain("document 2");
    expect(err).toContain("kind");
  });

  test("ignores indented apiVersion (not top-level)", () => {
    const err = validateManifestShape("  apiVersion: v1\n  kind: Service");
    expect(err).not.toBeNull();
  });

  test("ignores comment-only / blank documents", () => {
    const yaml = "apiVersion: v1\nkind: Service\n---\n# just a comment\n";
    expect(validateManifestShape(yaml)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resource summary
// ---------------------------------------------------------------------------
describe("summarizeResources", () => {
  test("counts kinds across documents", () => {
    const yaml = [
      "apiVersion: v1\nkind: Secret",
      "---",
      "apiVersion: apps/v1\nkind: Deployment",
      "---",
      "apiVersion: v1\nkind: Service",
      "---",
      "apiVersion: v1\nkind: Service",
    ].join("\n");
    expect(summarizeResources(yaml)).toEqual([
      { kind: "Deployment", count: 1 },
      { kind: "Secret", count: 1 },
      { kind: "Service", count: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// random secret
// ---------------------------------------------------------------------------
describe("generateSecret", () => {
  test("alphanumeric of given length", () => {
    const s = generateSecret(40, "alphanumeric");
    expect(s.length).toBe(40);
    expect(/^[A-Za-z0-9]+$/.test(s)).toBe(true);
  });
  test("hex charset", () => {
    const s = generateSecret(16, "hex");
    expect(/^[0-9a-f]+$/.test(s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// real catalog: baked apps scan to known placeholders
// ---------------------------------------------------------------------------
describe("catalog baked manifests", () => {
  test("vaultwarden manifest scans an ADMIN_TOKEN placeholder", () => {
    const vw = CATALOG.find((a) => a.id === "vaultwarden");
    const manifest = vw?.install?.manifest ?? "";
    expect(manifest.length).toBeGreaterThan(0);
    const filled = substitute(manifest, {
      instance: "vw",
      namespace: "default",
      hostname: "vw.example.com",
      storage: "5",
    });
    const placeholders = scanPlaceholders(filled);
    expect(placeholders.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// image-pinning policy: every baked manifest image must be version-pinned
// ---------------------------------------------------------------------------
describe("image pinning policy", () => {
  // A new app added with `image: foo/bar:latest` (or :stable/:main/…) fails
  // here. Pin it to a concrete version tag or an @sha256 digest instead.
  test("no manifest image uses a mutable/rolling tag", () => {
    const offenders: string[] = [];
    for (const app of CATALOG) {
      const manifest = app.install?.manifest;
      if (typeof manifest !== "string") continue;
      for (const ref of manifestImages(manifest)) {
        const reason = unpinnedReason(ref);
        if (reason) offenders.push(`${app.id}: ${ref} — ${reason}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
