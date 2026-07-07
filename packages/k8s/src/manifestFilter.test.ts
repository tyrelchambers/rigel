import { describe, expect, test } from "vitest";
import { dropManifestDocs } from "./manifestFilter";

const YAML = `apiVersion: apps/v1
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
kind: ConfigMap
metadata:
  name: web-config
`;

describe("dropManifestDocs", () => {
  test("removes matching docs (case-insensitive kind), keeps the rest", () => {
    const out = dropManifestDocs(YAML, [{ kind: "deployment", name: "web" }]);
    expect(out).not.toMatch(/kind: Deployment/);
    expect(out).toMatch(/kind: Service/);
    expect(out).toMatch(/kind: ConfigMap/);
  });

  test("removing everything yields an empty string", () => {
    const out = dropManifestDocs(YAML, [
      { kind: "Deployment", name: "web" },
      { kind: "Service", name: "web" },
      { kind: "ConfigMap", name: "web-config" },
    ]);
    expect(out).toBe("");
  });

  test("empty remove list returns the input unchanged", () => {
    expect(dropManifestDocs(YAML, [])).toBe(YAML);
  });

  test("non-matching name keeps the doc", () => {
    const out = dropManifestDocs(YAML, [{ kind: "Deployment", name: "other" }]);
    expect(out).toMatch(/kind: Deployment/);
  });
});
