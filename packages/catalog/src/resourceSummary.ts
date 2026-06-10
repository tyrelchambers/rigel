// Parse a multi-doc manifest into a {kind -> count} summary for the Review step.
// Pure string walk (no YAML lib) — counts top-level `kind:` declarations per
// document, matching the same column-0 rule as ManifestShape validation.

export interface ResourceCount {
  kind: string;
  count: number;
}

function splitDocuments(yaml: string): string[] {
  const docs: string[] = [];
  let current: string[] = [];
  for (const line of yaml.split("\n")) {
    if (line.trim() === "---") {
      docs.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  docs.push(current.join("\n"));
  return docs;
}

/** Extract the top-level `kind:` value from one document, or null. */
function topLevelKind(doc: string): string | null {
  for (const line of doc.split("\n")) {
    if (line.length === 0 || /\s/.test(line[0])) continue; // not column-0
    if (line.startsWith("kind:")) {
      const v = line.slice("kind:".length).trim();
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

/**
 * Count resources by kind across all documents, returned sorted by kind for a
 * stable display order. Documents without a top-level kind are ignored.
 */
export function summarizeResources(yaml: string): ResourceCount[] {
  const counts = new Map<string, number>();
  for (const doc of splitDocuments(yaml)) {
    const kind = topLevelKind(doc);
    if (!kind) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}
