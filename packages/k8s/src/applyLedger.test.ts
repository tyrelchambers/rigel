import { describe, expect, test } from "vitest";
import {
  parseAppliedResources,
  parseCreatedResources,
  parseExistingResources,
  resolveCreatedResources,
  ledgerNamespaceFor,
  buildLedgerManifest,
} from "./applyLedger";

const YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: shop
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: web-data
`;

const STDOUT = [
  "deployment.apps/web created",
  "service/web created",
  "persistentvolumeclaim/web-data created",
  "configmap/leftover configured",
  "Warning: some deprecation",
].join("\n");

describe("parseAppliedResources", () => {
  test("extracts kind/name/namespace from every doc", () => {
    expect(parseAppliedResources(YAML)).toEqual([
      { kind: "Deployment", name: "web", namespace: "shop" },
      { kind: "Service", name: "web", namespace: "shop" },
      { kind: "PersistentVolumeClaim", name: "web-data", namespace: undefined },
    ]);
  });

  test("ignores empty/null docs and docs missing kind or name", () => {
    expect(parseAppliedResources("---\n---\nfoo: bar\n")).toEqual([]);
  });
});

describe("parseCreatedResources", () => {
  test("keeps only 'created' lines, splitting the type token to a kind", () => {
    expect(parseCreatedResources(STDOUT)).toEqual([
      { kind: "deployment", name: "web" },
      { kind: "service", name: "web" },
      { kind: "persistentvolumeclaim", name: "web-data" },
    ]);
  });
});

describe("parseExistingResources", () => {
  test("keeps configured/unchanged (existing) lines, tolerating the dry-run suffix", () => {
    const stdout = [
      "deployment.apps/web created (server dry run)",
      "service/web configured (server dry run)",
      "persistentvolumeclaim/web-data unchanged",
      "configmap/web-config created",
    ].join("\n");
    expect(parseExistingResources(stdout)).toEqual([
      { kind: "service", name: "web" },
      { kind: "persistentvolumeclaim", name: "web-data" },
    ]);
  });
});

describe("resolveCreatedResources", () => {
  test("maps created (kind,name) to manifest kind + resolved namespace (default when omitted)", () => {
    const resources = resolveCreatedResources(parseCreatedResources(STDOUT), parseAppliedResources(YAML));
    expect(resources).toEqual([
      { kind: "Deployment", name: "web", namespace: "shop" },
      { kind: "Service", name: "web", namespace: "shop" },
      { kind: "PersistentVolumeClaim", name: "web-data", namespace: "default" },
    ]);
  });
});

describe("ledgerNamespaceFor", () => {
  test("returns the single shared namespace when all resources agree", () => {
    expect(ledgerNamespaceFor([
      { kind: "Deployment", name: "web", namespace: "shop" },
      { kind: "Service", name: "web", namespace: "shop" },
    ])).toBe("shop");
  });

  test("falls back to default for multi-namespace or empty batches", () => {
    expect(ledgerNamespaceFor([
      { kind: "Deployment", name: "web", namespace: "shop" },
      { kind: "Deployment", name: "api", namespace: "billing" },
    ])).toBe("default");
    expect(ledgerNamespaceFor([])).toBe("default");
  });
});

describe("buildLedgerManifest", () => {
  test("builds the ledger ConfigMap object in the given namespace with batch.json payload", () => {
    const resources = [{ kind: "Deployment", name: "web", namespace: "shop" }];
    const cm = buildLedgerManifest(
      { batchId: "b1", appliedAt: "2026-07-07T10:00:00.000Z", source: "compose-migration" },
      resources,
      "shop",
    );
    expect(cm.apiVersion).toBe("v1");
    expect(cm.kind).toBe("ConfigMap");
    expect(cm.metadata).toEqual({
      name: "rigel-apply-b1",
      namespace: "shop",
      labels: { "rigel.dev/ledger": "apply-batch" },
    });
    expect(JSON.parse(cm.data["batch.json"])).toEqual({
      batchId: "b1",
      appliedAt: "2026-07-07T10:00:00.000Z",
      source: "compose-migration",
      resources,
    });
  });
});
