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

export interface ResourceRef { kind: string; name: string; namespace?: string }

/** A parsed resource paired with its original manifest document, so a SUBSET of
 * a multi-doc manifest can be re-emitted (e.g. selective uninstall). */
export interface ResourceDoc extends ResourceRef { doc: string }

/** Strip matching surrounding single/double quotes from a scalar value. */
function unquote(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Leading-space count of a line. */
function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

/** Pull `field` out of an inline flow mapping like `{name: x, namespace: y}`. */
function flowField(inline: string, field: "name" | "namespace"): string | undefined {
  const inner = inline.slice(inline.indexOf("{") + 1, inline.lastIndexOf("}"));
  for (const part of inner.split(",")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === field) {
      const v = part.slice(idx + 1).trim();
      if (v.length > 0) return unquote(v);
    }
  }
  return undefined;
}

/**
 * Extract `name`/`namespace` from the first column-0 `metadata:` block. Handles
 * block style at ANY indentation — reading only the block's DIRECT children, so a
 * nested `labels.name` is never mistaken for the resource name — and inline flow
 * mappings (`metadata: {name: x}`). Model-emitted manifests vary in indentation
 * (2-space, 4-space, flow), so this must not assume a fixed 2-space layout.
 */
function metaField(doc: string, field: "name" | "namespace"): string | undefined {
  const lines = doc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0 || /\s/.test(line[0])) continue; // want a column-0 key
    if (!line.startsWith("metadata:")) continue;

    const inline = line.slice("metadata:".length).trim();
    if (inline.startsWith("{")) return flowField(inline, field);

    // Block style: the block's direct children share the shallowest following
    // indent; lines deeper than that are nested values (labels/annotations) and
    // must be skipped so their keys can't shadow the real name/namespace.
    let childIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim().length === 0) continue;
      const ind = indentOf(l);
      if (ind === 0) break; // next top-level key → metadata block ended
      if (childIndent === -1) childIndent = ind;
      if (ind !== childIndent) continue; // nested deeper than a direct child
      const trimmed = l.trim();
      if (trimmed.startsWith(`${field}:`)) {
        const v = trimmed.slice(field.length + 1).trim();
        if (v.length > 0) return unquote(v);
      }
    }
    return undefined;
  }
  return undefined;
}

/** Per-document {kind,name,namespace,doc}. Docs without a top-level kind are skipped. */
export function listResourceDocs(yaml: string): ResourceDoc[] {
  const out: ResourceDoc[] = [];
  for (const doc of splitDocuments(yaml)) {
    const kind = topLevelKind(doc);
    if (!kind) continue;
    out.push({ kind, name: metaField(doc, "name") ?? "", namespace: metaField(doc, "namespace"), doc });
  }
  return out;
}

/** Re-emit a multi-doc manifest from a subset of its documents. */
export function joinResourceDocs(docs: ResourceDoc[]): string {
  return docs.map((d) => d.doc).join("\n---\n") + "\n";
}

/** Per-document {kind,name,namespace}. Docs without a top-level kind are skipped. */
export function listResources(yaml: string): ResourceRef[] {
  return listResourceDocs(yaml).map(({ kind, name, namespace }) => ({ kind, name, namespace }));
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
