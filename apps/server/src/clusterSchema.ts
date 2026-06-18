// Fetches the apiserver's OpenAPI v2 (Swagger) document and converts it to a
// monaco-yaml JSON Schema, cached per kube-context for the process lifetime
// (CRDs/version change rarely; a server restart re-fetches). Returns null when
// the fetch or conversion fails — the client edits lint-only (NO static fallback).
import { kubectl } from "@helmsman/k8s/src/run";
import { openapiV2ToYamlSchema } from "@helmsman/k8s/src/openapiSchema";

const cache = new Map<string, Record<string, unknown> | null>();

export async function getClusterYamlSchema(context: string | null): Promise<Record<string, unknown> | null> {
  const key = context ?? "__current__";
  if (cache.has(key)) return cache.get(key) ?? null;
  const res = await kubectl(context, ["get", "--raw", "/openapi/v2"]);
  let schema: Record<string, unknown> | null = null;
  if (res.code === 0) {
    try {
      schema = openapiV2ToYamlSchema(JSON.parse(res.stdout));
    } catch {
      schema = null;
    }
  }
  cache.set(key, schema);
  return schema;
}
