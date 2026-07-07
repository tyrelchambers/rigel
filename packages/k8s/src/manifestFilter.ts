// Drop selected documents from a multi-doc manifest string. Pure; used to skip
// resources that already exist so a Compose migration apply never overwrites
// them. Re-serializes via the `yaml` document model (semantically identical).

import { parseAllDocuments } from "yaml";

export interface ResourceRef {
  kind: string;
  name: string;
}

/**
 * Return `yaml` with every document whose kind+name matches one of `remove`
 * omitted. Kind match is case-insensitive. Documents without a kind/name are
 * kept as-is. Returns "" when nothing remains.
 */
export function dropManifestDocs(yaml: string, remove: ResourceRef[]): string {
  if (remove.length === 0) return yaml;
  const drop = new Set(remove.map((r) => `${r.kind.toLowerCase()}/${r.name}`));
  const kept: string[] = [];
  for (const doc of parseAllDocuments(yaml)) {
    const obj = doc.toJSON() as { kind?: unknown; metadata?: { name?: unknown } } | null;
    if (
      obj &&
      typeof obj.kind === "string" &&
      typeof obj.metadata?.name === "string" &&
      drop.has(`${obj.kind.toLowerCase()}/${obj.metadata.name}`)
    ) {
      continue;
    }
    const text = doc.toString().trim();
    if (text && text !== "null") kept.push(text);
  }
  return kept.length ? kept.join("\n---\n") + "\n" : "";
}
