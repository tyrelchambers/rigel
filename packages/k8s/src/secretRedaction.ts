// Secret values never reach the model.
//
// Adoption exports live resources into a repo, Secrets included. The decision
// is to redact rather than refuse: the export still records that a Secret
// exists, its name, type and key names, so a workload whose envFrom points at
// one stays complete. It just never carries a value.
//
// This is an output filter, deliberately, not a prompt instruction. A model
// asked not to read Secrets, or not to repeat what it read, is not a control.
// The values are gone before the model is handed the text.

import { isMap, isSeq, parseAllDocuments, parseDocument, type Document } from "yaml";

/**
 * What replaces a value. Quoted so it survives a YAML round trip as a plain
 * string, worded so the model reads deliberate policy rather than an empty
 * field it should go and fix, and NOT valid base64, so a manifest carrying it
 * under `data:` fails `kubectl apply` loudly instead of silently overwriting a
 * live Secret with this text.
 */
export const REDACTED = "(redacted by Rigel)";

const VALUE_FIELDS = ["data", "stringData"];

/** Blank every value under data/stringData of a Secret, in place. */
function redactNode(node: unknown): boolean {
  if (!isMap(node)) return false;
  let touched = false;
  const kind = node.get("kind");
  if (kind === "Secret") {
    for (const field of VALUE_FIELDS) {
      const values = node.get(field);
      if (!isMap(values)) continue;
      for (const item of values.items) {
        node.setIn([field, item.key], REDACTED);
        touched = true;
      }
    }
  }
  // A multi-kind get returns a v1 List, and a Secret inside it is still a
  // Secret. Nothing here depends on the wrapper's own kind.
  const items = node.get("items");
  if (isSeq(items)) {
    for (const item of items.items) if (redactNode(item)) touched = true;
  }
  return touched;
}

function redactDocuments(docs: Document[]): boolean {
  let touched = false;
  for (const doc of docs) if (redactNode(doc.contents)) touched = true;
  return touched;
}

/**
 * Return `text` with every Secret value replaced. JSON and YAML are both
 * handled, in the shape they arrived in. Output that parses as neither is
 * passed through: kubectl's table and describe views print key names and byte
 * counts, never values, so there is nothing in them to remove.
 */
export function redactSecretValues(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const doc = parseDocument(text);
      if (doc.errors.length > 0) return text;
      if (!redactNode(doc.contents)) return text;
      return JSON.stringify(doc.toJSON(), null, 2);
    } catch {
      return text;
    }
  }
  try {
    const docs = parseAllDocuments(text);
    if (docs.length === 0 || docs.some((d) => d.errors.length > 0)) return text;
    if (!redactDocuments(docs)) return text;
    return docs.map((d) => d.toString()).join("");
  } catch {
    return text;
  }
}
