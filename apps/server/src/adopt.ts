// Export a live workload and everything around it into manifests a repo can
// hold, so an app that exists only in the cluster becomes one that can be
// redeployed from Git.
//
// This is the half of the request no model should do. It was asked for three
// times over voice, and every attempt failed the same way: the assistant read
// the resources into its own context and then had to retype them, which is
// slow, lossy, and expressible only as an action kind that does not exist. Here
// the model names the workload and nothing else; discovery, export, cleaning
// and layout all happen server-side in one call.
import { cleanExportedManifest } from "@rigel/k8s/src/manifestClean";
import { redactSecretValues } from "@rigel/k8s/src/secretRedaction";
import { kubectl } from "@rigel/k8s/src/run";
import { referencedResources, routingFor, type ClusterObject } from "@rigel/k8s/src/workloadClosure";
import { discover } from "./purge";

/** One file bound for the repo. */
export interface ExportedFile {
  path: string;
  content: string;
}

export interface AdoptPlan {
  ok: boolean;
  files?: ExportedFile[];
  /** Kind/name pairs, for what the operator is told was included. */
  included?: string[];
  message?: string;
}

/**
 * A Secret is exported as its shape and never its values: name, type and keys,
 * with every value redacted. The `.example` suffix is load-bearing, not
 * decoration. `kubectl apply -f <dir> -R` ignores a file that is not .yaml or
 * .json, so a synced repo can never apply this over the live Secret and blank
 * its real values. What the repo gets is an honest description of what the app
 * needs, which is the point of adopting it.
 */
const SECRET_EXAMPLE_SUFFIX = ".yaml.example";

const HEADER = [
  "# Exported from the live cluster by Rigel.",
  "# Values are redacted: fill them in before applying, and never commit real ones.",
  "",
].join("\n");

/** `<kind>-<name>.yaml`, because a Deployment and its Service share a name. */
export function fileNameFor(kind: string, name: string): string {
  return `${kind.toLowerCase()}-${name}.yaml`;
}

/**
 * Read one resource as YAML and clean it for export. Returns null when the read
 * fails, so one unreadable resource never sinks the whole adoption.
 */
async function exportOne(
  context: string | null,
  kind: string,
  name: string,
  namespace: string,
): Promise<string | null> {
  const res = await kubectl(context, [
    "get",
    kind,
    name,
    "-n",
    namespace,
    "-o",
    "yaml",
    "--show-managed-fields=false",
  ]);
  if (res.code !== 0) return null;
  return cleanExportedManifest(res.stdout);
}

/** Read one kind in a namespace as objects, or an empty list. */
async function listObjects(context: string | null, kind: string, namespace: string): Promise<ClusterObject[]> {
  const res = await kubectl(context, ["get", kind, "-n", namespace, "-o", "json"]);
  if (res.code !== 0) return [];
  try {
    return (JSON.parse(res.stdout) as { items?: ClusterObject[] }).items ?? [];
  } catch {
    return [];
  }
}

/** Read one object, or null. */
async function readObject(
  context: string | null,
  kind: string,
  name: string,
  namespace: string,
): Promise<ClusterObject | null> {
  const res = await kubectl(context, ["get", kind, name, "-n", namespace, "-o", "json"]);
  if (res.code !== 0) return null;
  try {
    return JSON.parse(res.stdout) as ClusterObject;
  } catch {
    return null;
  }
}

/**
 * What belongs to this workload, by following what the cluster states rather
 * than by matching names.
 *
 * The purge engine's name-prefix pass is right for a removal flow, where the
 * operator reads and confirms the list. Here it was wrong and dangerously so:
 * asked about reddex-deploy it also returned reddex-custom-website-deploy and
 * its service and ingress, a different app sharing a prefix, and committing
 * those would have put a second app's manifests in the first one's repo. The
 * Service that selects this workload's pod labels, and the Ingress that routes
 * to that Service, are facts the objects state about themselves.
 */
async function relatedTo(
  context: string | null,
  workload: { kind: string; name: string; namespace: string },
): Promise<{ kind: string; name: string; namespace: string }[]> {
  const ns = workload.namespace;
  const object = await readObject(context, workload.kind, workload.name, ns);
  if (!object) return [];

  const [services, ingresses] = await Promise.all([
    listObjects(context, "service", ns),
    listObjects(context, "ingress", ns),
  ]);
  const routing = routingFor(object, services, ingresses);

  return [
    { kind: workload.kind, name: workload.name, namespace: ns },
    ...routing.services.map((name) => ({ kind: "service", name, namespace: ns })),
    ...routing.ingresses.map((name) => ({ kind: "ingress", name, namespace: ns })),
    ...referencedResources(object).map((r) => ({ kind: r.kind, name: r.name, namespace: ns })),
  ];
}

/**
 * Everything belonging to `name`, as files. Discovery follows the workload's
 * own declarations; the purge engine is consulted only for the two things it
 * alone knows, a protected namespace and a Helm release.
 */
export async function planAdoption(
  context: string | null,
  workload: { kind: string; name: string; namespace: string },
  manifestDir: string,
): Promise<AdoptPlan> {
  const found = await discover(context, workload.namespace, workload.name);
  if (found.blockedReason) return { ok: false, message: found.blockedReason };
  if (found.helmRelease) {
    return {
      ok: false,
      message: `${workload.name} is a Helm release (${found.helmRelease}). Its manifests are rendered from the chart, so exporting them would commit a copy that drifts from it. Adopt the chart's values instead.`,
    };
  }

  const resources = await relatedTo(context, workload);
  if (resources.length === 0) {
    return { ok: false, message: `Could not read ${workload.kind} ${workload.name} in ${workload.namespace}.` };
  }
  const files: ExportedFile[] = [];
  const included: string[] = [];
  const unreadable: string[] = [];

  for (const resource of resources) {
    const yaml = await exportOne(context, resource.kind, resource.name, resource.namespace);
    if (yaml === null) {
      unreadable.push(`${resource.kind}/${resource.name}`);
      continue;
    }
    const isSecret = resource.kind.toLowerCase() === "secret";
    const name = fileNameFor(resource.kind, resource.name);
    files.push({
      path: `${manifestDir === "." ? "" : `${manifestDir}/`}${isSecret ? `${name}.example`.replace(".yaml.example", SECRET_EXAMPLE_SUFFIX) : name}`,
      content: isSecret ? `${HEADER}${redactSecretValues(yaml)}` : yaml,
    });
    included.push(`${resource.kind}/${resource.name}`);
  }

  if (files.length === 0) {
    return {
      ok: false,
      message: `Nothing could be read for ${workload.name} in ${workload.namespace}${unreadable.length ? ` (${unreadable.join(", ")} failed)` : ""}.`,
    };
  }
  return { ok: true, files, included };
}
