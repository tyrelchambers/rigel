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

/**
 * Everything belonging to `name`, as files. The discovery engine is the purge
 * one: instance label first, name prefix second, which is what finds an app in
 * a cluster that labels things its own way.
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

  const resources = found.discovered.length > 0 ? found.discovered : [{ ...workload }];
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
