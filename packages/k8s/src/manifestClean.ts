import { isMap, parseDocument, type Document } from "yaml";
import { SOURCE_PATH_ANNOTATION, SOURCE_REPO_ANNOTATION } from "./gitSources.js";

// Hand-rolled manifest tidy for the live-resource editor — no YAML dependency in
// the bundle (matches the project's other hand-rolled YAML editors). Removes the
// top-level `status:` block (server-computed, not meant to be edited/applied).
// managedFields are excluded upstream via `kubectl get --show-managed-fields=false`.

/** Drop a top-level `status:` mapping from single-doc `kubectl get -o yaml`
 *  output. A top-level key sits at column 0; the block runs until the next
 *  column-0 key or EOF. An indented `status:` (a data/spec key) is left alone. */
export function stripStatusBlock(yaml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of yaml.split("\n")) {
    if (skipping) {
      if (line === "" || /^\s/.test(line)) continue; // still inside status:
      skipping = false; // a new column-0 key ends the block
    }
    if (/^status:(\s|$)/.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  // Preserve the input's trailing newline when a final status: block consumed it.
  const result = out.join("\n");
  return yaml.endsWith("\n") && !result.endsWith("\n") ? result + "\n" : result;
}


/**
 * Turn one live object into a manifest that applies cleanly somewhere else.
 *
 * `stripStatusBlock` above is the live editor's tidy and removes only `status`,
 * which is right for showing someone their own object and useless for a file
 * meant to be applied fresh: `metadata.uid`, `resourceVersion`, a Service's
 * allocated clusterIP and a PVC's bound volumeName all pin the object to the
 * cluster it came from, and kubectl rejects or silently mis-binds them.
 *
 * The principle is narrow on purpose: strip what the API server owns, and what
 * ties the object to this cluster. A defaulted but legal field is left alone,
 * because guessing at what the operator "meant" is how an export quietly stops
 * describing what is actually running. `metadata.namespace` is KEPT, matching
 * the namespace rule planManifestEdit matches on.
 *
 * The yaml Document API is used here rather than the line-wise approach above,
 * because this path is server-side; the no-dependency constraint bound the
 * browser-reachable editor, not this.
 */
export function cleanExportedManifest(yaml: string): string {
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0) return yaml;

  for (const path of [
    ["status"],
    ["metadata", "uid"],
    ["metadata", "resourceVersion"],
    ["metadata", "creationTimestamp"],
    ["metadata", "generation"],
    ["metadata", "selfLink"],
    ["metadata", "managedFields"],
    ["metadata", "ownerReferences"],
  ]) {
    doc.deleteIn(path);
  }

  dropAnnotations(doc, ["metadata", "annotations"]);
  dropAnnotations(doc, ["spec", "template", "metadata", "annotations"]);

  const kind = doc.get("kind");
  if (kind === "Service") {
    for (const field of [
      "clusterIP",
      "clusterIPs",
      "ipFamilies",
      "ipFamilyPolicy",
      "internalTrafficPolicy",
      "healthCheckNodePort",
    ]) {
      doc.deleteIn(["spec", field]);
    }
  }
  if (kind === "PersistentVolumeClaim") doc.deleteIn(["spec", "volumeName"]);

  return doc.toString();
}

/** Annotations the cluster wrote, or that a sync will write again. */
const DROPPED_ANNOTATIONS = [
  "kubectl.kubernetes.io/last-applied-configuration",
  "kubectl.kubernetes.io/restartedAt",
  "deployment.kubernetes.io/revision",
  SOURCE_REPO_ANNOTATION,
  SOURCE_PATH_ANNOTATION,
];

const DROPPED_PREFIXES = ["pv.kubernetes.io/", "volume.kubernetes.io/", "volume.beta.kubernetes.io/"];

function dropAnnotations(doc: Document, path: string[]): void {
  const map = doc.getIn(path);
  if (!isMap(map)) return;
  for (const item of [...map.items]) {
    const key = String(item.key);
    const drop = DROPPED_ANNOTATIONS.includes(key) || DROPPED_PREFIXES.some((p) => key.startsWith(p));
    if (drop) doc.deleteIn([...path, item.key as never]);
  }
  if (isMap(doc.getIn(path)) && (doc.getIn(path) as { items: unknown[] }).items.length === 0) doc.deleteIn(path);
}
