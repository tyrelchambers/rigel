// Converts a Kubernetes apiserver OpenAPI v2 (Swagger) document into a single
// JSON Schema for monaco-yaml: a top-level `oneOf` over every GroupVersionKind,
// each branch pinning apiVersion+kind so each `---` document in a multi-doc
// manifest validates against the right resource (core kinds AND the cluster's
// CRDs). Returns null when the input isn't a usable OpenAPI v2 doc — the caller
// then runs the editor lint-only (no static fallback, by design).

interface OpenApiV2 {
  definitions?: Record<string, OpenApiDefinition>;
}
interface GVK { group: string; version: string; kind: string }
interface OpenApiDefinition {
  "x-kubernetes-group-version-kind"?: GVK[];
  [k: string]: unknown;
}

/** apiVersion string for a GVK: "v1" for the core group, else "group/version". */
export function gvkApiVersion(gvk: { group: string; version: string }): string {
  return gvk.group ? `${gvk.group}/${gvk.version}` : gvk.version;
}

/** Convert a parsed apiserver OpenAPI v2 document into a monaco-yaml JSON Schema
 *  (a `oneOf` over every GroupVersionKind, with the original `definitions`
 *  carried through for `$ref` resolution). Returns null when `raw` isn't a usable
 *  OpenAPI v2 doc — the caller then runs the editor lint-only. */
export function openapiV2ToYamlSchema(raw: unknown): Record<string, unknown> | null {
  if (
    raw === null ||
    typeof raw !== "object" ||
    typeof (raw as { definitions?: unknown }).definitions !== "object" ||
    (raw as { definitions?: unknown }).definitions === null
  ) {
    return null;
  }
  const definitions = (raw as OpenApiV2).definitions as Record<string, OpenApiDefinition>;
  const oneOf: Array<Record<string, unknown>> = [];
  for (const [defName, def] of Object.entries(definitions)) {
    const gvks = def?.["x-kubernetes-group-version-kind"];
    if (!Array.isArray(gvks) || gvks.length === 0) continue;
    for (const gvk of gvks) {
      if (!gvk?.kind || !gvk?.version) continue;
      oneOf.push({
        type: "object",
        required: ["apiVersion", "kind"],
        properties: {
          apiVersion: { const: gvkApiVersion(gvk) },
          kind: { const: gvk.kind },
        },
        allOf: [{ $ref: `#/definitions/${defName}` }],
      });
    }
  }
  if (oneOf.length === 0) return null;
  return { definitions: definitions as Record<string, unknown>, oneOf };
}
