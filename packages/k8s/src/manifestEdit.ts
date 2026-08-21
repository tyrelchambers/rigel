// Typed manifest edits — take the change the operator asked for as an intent
// ("set this annotation", "use this image") and produce the edited file, rather
// than asking a model to retype a whole manifest. Pure: files in, one edited
// file out, so the caller does the cloning and the committing (repoFix.ts) and
// this unit-tests with no I/O.
//
// Every failure is a sentence the assistant can speak as-is. Nothing here
// guesses: an ambiguous target refuses and names the candidates.

import { isCollection, isMap, parseAllDocuments, type Document } from "yaml";

export type ManifestEdit =
  | { op: "annotate"; annotations: Record<string, string | null> }
  | { op: "label"; labels: Record<string, string | null> }
  | { op: "setImage"; container?: string; image: string }
  | { op: "scale"; replicas: number };

export interface ManifestFile {
  /** Path within the repo, used in messages and returned as the file to change. */
  path: string;
  content: string;
}

/** The live object the edit targets, plus the directory searched (messages only). */
export interface ManifestTarget {
  kind: string;
  name: string;
  namespace: string;
  dir: string;
}

export type ManifestEditPlan =
  | { ok: true; filePath: string; content: string }
  | { ok: false; message: string };

/** Where a pod template's containers live, in the order they are tried. */
const CONTAINER_PATHS = [
  ["spec", "template", "spec", "containers"],
  ["spec", "containers"],
  ["spec", "jobTemplate", "spec", "template", "spec", "containers"],
];

const refuse = (message: string): ManifestEditPlan => ({ ok: false, message });

function matches(doc: Document, target: ManifestTarget): boolean {
  const obj = doc.toJSON() as { kind?: unknown; metadata?: { name?: unknown; namespace?: unknown } } | null;
  if (!obj || typeof obj.kind !== "string") return false;
  if (obj.kind.toLowerCase() !== target.kind.toLowerCase()) return false;
  if (obj.metadata?.name !== target.name) return false;
  const ns = obj.metadata?.namespace;
  return ns === undefined || ns === null || ns === target.namespace;
}

/**
 * Find the one document defining `target` across `files` and apply `edit` to it.
 * Zero matches, several matches, or an edit that would change nothing all
 * refuse with the reason; nothing is ever edited on a guess.
 */
export function planManifestEdit(
  files: ManifestFile[],
  target: ManifestTarget,
  edit: ManifestEdit,
): ManifestEditPlan {
  const unparsed: string[] = [];
  const hits: { file: ManifestFile; docs: Document[]; index: number }[] = [];

  for (const file of files) {
    const docs = parseAllDocuments(file.content);
    if (docs.some((d) => d.errors.length > 0)) {
      unparsed.push(file.path);
      continue;
    }
    docs.forEach((doc, index) => {
      if (matches(doc, target)) hits.push({ file, docs, index });
    });
  }

  const named = `${target.kind} ${target.name} in namespace ${target.namespace}`;
  if (hits.length === 0) {
    const templated = unparsed.length
      ? ` Some files could not be read as YAML (${unparsed.join(", ")}), so these manifests may be templated, and Rigel cannot edit templated manifests.`
      : "";
    return refuse(`No manifest under ${target.dir} defines ${named}.${templated}`);
  }
  if (hits.length > 1) {
    const where = hits.map((h) => h.file.path).join(", ");
    return refuse(`More than one manifest defines ${named} (${where}), so Rigel will not guess which one to change.`);
  }

  const hit = hits[0]!;
  const doc = hit.docs[hit.index]!;
  const failure = applyEdit(doc, edit, named);
  if (failure) return refuse(failure);

  return { ok: true, filePath: hit.file.path, content: hit.docs.map((d) => d.toString()).join("") };
}

/** Mutates `doc` in place. Returns a refusal sentence, or null when it changed something. */
function applyEdit(doc: Document, edit: ManifestEdit, named: string): string | null {
  switch (edit.op) {
    case "annotate":
      return applyMetadata(doc, "annotations", edit.annotations, named);
    case "label":
      return applyMetadata(doc, "labels", edit.labels, named);
    case "setImage":
      return applyImage(doc, edit, named);
    case "scale":
      return applyReplicas(doc, edit.replicas, named);
  }
}

function applyMetadata(
  doc: Document,
  field: "annotations" | "labels",
  values: Record<string, string | null>,
  named: string,
): string | null {
  const keys = Object.keys(values);
  if (keys.length === 0) return `That edit names no ${field} to change.`;

  const singular = field === "annotations" ? "annotation" : "label";
  let changed = false;
  for (const key of keys) {
    const value = values[key]!;
    const current = doc.getIn(["metadata", field, key]);
    if (value === null) {
      if (current === undefined) return `The ${named} has no ${singular} "${key}", so there is nothing to remove.`;
      doc.deleteIn(["metadata", field, key]);
      changed = true;
      continue;
    }
    if (current === value) continue;
    doc.setIn(["metadata", field, key], value);
    changed = true;
  }
  if (!changed) return `The ${named} already carries those ${field}, so there is nothing to change.`;

  const map = doc.getIn(["metadata", field]);
  if (isCollection(map) && map.items.length === 0) doc.deleteIn(["metadata", field]);
  return null;
}

function applyImage(doc: Document, edit: { container?: string; image: string }, named: string): string | null {
  const path = CONTAINER_PATHS.find((p) => isCollection(doc.getIn(p)));
  if (!path) return `The ${named} declares no containers in its manifest, so its image cannot be set.`;

  const containers = doc.getIn(path) as { items: unknown[] };
  const names = containers.items.map((_, i) => doc.getIn([...path, i, "name"]));
  const readable = names.filter((n) => typeof n === "string").join(", ");

  let index: number;
  if (edit.container === undefined) {
    if (containers.items.length !== 1) {
      return `The ${named} has more than one container (${readable}), so name the one whose image should change.`;
    }
    index = 0;
  } else {
    index = names.indexOf(edit.container);
    if (index === -1) {
      return `The ${named} has no container called "${edit.container}", its containers are ${readable}.`;
    }
  }

  if (doc.getIn([...path, index, "image"]) === edit.image) {
    return `That container already runs ${edit.image}, so there is nothing to change.`;
  }
  doc.setIn([...path, index, "image"], edit.image);
  return null;
}

function applyReplicas(doc: Document, replicas: number, named: string): string | null {
  if (!Number.isInteger(replicas) || replicas < 0) return `A replica count must be a whole number of zero or more.`;
  if (!isMap(doc.getIn(["spec"]))) return `The ${named} has no spec in its manifest, so its replicas cannot be set.`;
  if (doc.getIn(["spec", "replicas"]) === replicas) {
    return `The ${named} is already set to ${replicas} replicas, so there is nothing to change.`;
  }
  doc.setIn(["spec", "replicas"], replicas);
  return null;
}
