/**
 * Action-block → kubectl argv mapping.
 *
 * Each kind mirrors the EXACT kubectl invocation built by
 * `WorkloadAction.kubectlInvocations()` in the Swift app
 * (Sources/Rigel/Panels/Actions/WorkloadAction.swift).
 *
 * Per-kind argv table (derived from Swift source):
 *
 * restart          rollout restart <workloadKind>/<name> -n <ns>
 *                  workloadKind defaults to "deployment"; use resourceKind for sts/ds.
 * scale            scale <workloadKind>/<name> --replicas=<n> -n <ns>
 * rollback         rollout undo deployment/<name> -n <ns>
 * pause            rollout pause deployment/<name> -n <ns>
 * resume           rollout resume deployment/<name> -n <ns>
 * setEnv           set env deployment/<name> -n <ns> KEY=val... (sorted)
 * setImage         set image <workloadKind>/<name> <container>=<image> -n <ns>
 * setResources     set resources <workloadKind>/<name> -c <container>
 *                    [--requests=<r>] [--limits=<l>] -n <ns>   (empty flags omitted)
 * deletePod        delete pod <pod> -n <ns>
 * deleteWorkload   delete <resourceKind> <name> -n <ns>
 * cordon           cordon <node>
 * uncordon         uncordon <node>
 * drain            drain <node> [--ignore-daemonsets] [--delete-emptydir-data]
 *                    [--force] [--disable-eviction]  (default opts applied)
 * suspendCronJob   patch cronjob <name> -n <ns> --type=merge -p {"spec":{"suspend":true}}
 * resumeCronJob    patch cronjob <name> -n <ns> --type=merge -p {"spec":{"suspend":false}}
 * triggerCronJob   create job <jobName> --from=cronjob/<name> -n <ns>
 *                  jobName comes from `pod` field (Swift uses CronJob.manualRunName)
 * createNamespace  create namespace <name>
 * deleteNamespace  delete namespace <name>
 * deleteResource   varies by resourceKind (see resolveDeleteResource); RBAC cluster-scoped
 *                  kinds (clusterrole/clusterrolebinding) have no -n flag.
 * setImagePullSecrets patch <workloadKind>/<name> -n <ns> --type=merge -p {"spec":{"template":{"spec":{"imagePullSecrets":[{"name":...}]}}}}
 *                    Full desired list (merge patch replaces the array; [] clears).
 * setEnvRef        patch <workloadKind>/<name> -n <ns> --type=strategic -p {... containers[].env[] valueFrom secret/configMapKeyRef ...}
 *                    Per-container; strategic merge keys containers+env by name. Requires container.
 * command          args[] verbatim (pre-filtered empty strings by Swift)
 * purge            throws PurgeActionError — handled by the client purge flow, not kubectl.
 */

export interface ActionBlock {
  kind: string;
  label?: string;
  /** Primary target: controller, cronjob, namespace, or resource name. */
  name?: string;
  /** Back-compat alias for `name` (legacy `deployment` field). */
  deployment?: string;
  pod?: string;
  node?: string;
  namespace?: string;
  replicas?: number;
  env?: Record<string, string>;
  /** setEnv only: env var names to remove (kubectl `KEY-` unset syntax). */
  unsetEnv?: string[];
  container?: string;
  image?: string;
  /** kubectl --requests quantity string e.g. "cpu=250m,memory=512Mi". */
  requests?: string;
  /** kubectl --limits quantity string e.g. "cpu=500m,memory=1Gi". */
  limits?: string;
  /**
   * For deleteResource: the kubectl resource kind (service, pvc, pv, ingress,
   * role, clusterrole, …).
   * For restart/scale/setImage/setResources/deleteWorkload: the workload kind
   * (deployment, statefulset, daemonset, job, cronjob). Defaults to "deployment".
   */
  resourceKind?: string;
  /**
   * linkCatalogApp only: the catalog app `id` the workload is bound to
   * (value of the `rigel.dev/catalog-app` annotation).
   */
  appID?: string;
  /**
   * `command` only: literal kubectl args WITHOUT the `kubectl` binary or
   * `--context`. App prepends both.
   */
  args?: string[];
  /** `command` only: Claude's destructiveness hint. */
  destructive?: boolean;
  /** applyManifest only — manifest YAML, applied via /api/apply. */
  manifest?: string;
  /** proposeRepoFix only — git source name, repo file path, PR title/body, new content. */
  source?: string;
  filePath?: string;
  title?: string;
  body?: string;
  content?: string;
  /** setImagePullSecrets only — desired full list of imagePullSecret names. */
  imagePullSecrets?: string[];
  /** setEnvRef only — env vars sourced from a Secret/ConfigMap key. */
  envRefs?: Array<{ name: string; source: "secret" | "configMap"; resourceName: string; key: string }>;
}

/** Thrown when `kind === "purge"` — not a kubectl command; caller opens purge flow. */
export class PurgeActionError extends Error {
  constructor(name?: string) {
    super(`purge is handled by the dedicated app-removal sheet (target: ${name ?? "unknown"})`);
    this.name = "PurgeActionError";
  }
}

/** `name ?? deployment ?? ""` — mirrors Swift `SuggestedAction.target`. */
const target = (a: ActionBlock): string => a.name ?? a.deployment ?? "";

/** Workload kind string, defaulting to "deployment". */
const workloadKind = (a: ActionBlock): string =>
  a.resourceKind ?? "deployment";

/**
 * Map a `deleteResource` resourceKind to a kubectl delete invocation.
 * Mirrors `SuggestedActionResolver.resolveDelete` in Swift.
 *
 * Cluster-scoped kinds (pv, clusterrole, clusterrolebinding) omit -n.
 * Namespaced kinds append -n <ns>.
 */
function resolveDeleteResource(a: ActionBlock): string[] {
  const rk = (a.resourceKind ?? "").toLowerCase();
  const name = target(a);
  const ns = a.namespace;

  // Cluster-scoped resources — no namespace flag
  const clusterScoped = new Set(["pv", "persistentvolume", "clusterrole", "clusterrolebinding"]);
  if (clusterScoped.has(rk)) {
    return ["delete", rk === "persistentvolume" ? "pv" : rk, name];
  }

  // Normalise aliases
  let kubectl_kind = rk;
  if (rk === "svc") kubectl_kind = "service";
  if (rk === "ing") kubectl_kind = "ingress";
  if (rk === "cm") kubectl_kind = "configmap";
  if (rk === "persistentvolumeclaim") kubectl_kind = "pvc";
  if (rk === "order") kubectl_kind = "orders.acme.cert-manager.io";
  if (rk === "challenge") kubectl_kind = "challenges.acme.cert-manager.io";
  if (rk === "certificaterequest") kubectl_kind = "certificaterequests.cert-manager.io";
  if (rk === "certificate") kubectl_kind = "certificates.cert-manager.io";

  const nsFlags = ns ? ["-n", ns] : [];
  return ["delete", kubectl_kind, name, ...nsFlags];
}

/**
 * Build the kubectl argv for an ActionBlock.
 *
 * The caller prepends `kubectl [--context <ctx>]`; this function returns only
 * the arguments (verb onward), matching Swift's `KubectlInvocation.args`.
 *
 * @throws {PurgeActionError} for kind === "purge" — caller must open purge flow.
 * @throws {Error} for unknown kinds.
 */
export function buildCommand(a: ActionBlock): string[] {
  const ns = a.namespace ? ["-n", a.namespace] : [];

  switch (a.kind) {
    // -----------------------------------------------------------------------
    // rollout operations
    // -----------------------------------------------------------------------
    case "restart": {
      const wk = workloadKind(a);
      return ["rollout", "restart", `${wk}/${target(a)}`, ...ns];
    }

    case "rollback":
      return ["rollout", "undo", `deployment/${target(a)}`, ...ns];

    case "pause":
      return ["rollout", "pause", `deployment/${target(a)}`, ...ns];

    case "resume":
      return ["rollout", "resume", `deployment/${target(a)}`, ...ns];

    // -----------------------------------------------------------------------
    // scale
    // -----------------------------------------------------------------------
    case "scale": {
      const wk = workloadKind(a);
      return ["scale", `${wk}/${target(a)}`, `--replicas=${a.replicas}`, ...ns];
    }

    // -----------------------------------------------------------------------
    // set env — Swift: sorted key=value pairs appended after deployment+ns
    // setDeploymentEnv: ["set","env","deployment/<name>","-n",ns,...sorted_pairs]
    // -----------------------------------------------------------------------
    case "setEnv": {
      const sets = Object.entries(a.env ?? {}).map(([k, v]) => `${k}=${v}`);
      const unsets = (a.unsetEnv ?? []).map((k) => `${k}-`);
      const pairs = [...sets, ...unsets].sort();
      const containers = a.container ? [`--containers=${a.container}`] : [];
      return ["set", "env", `deployment/${target(a)}`, ...containers, ...ns, ...pairs];
    }

    // -----------------------------------------------------------------------
    // setImage — set image <kind>/<name> <container>=<image> -n <ns>
    // -----------------------------------------------------------------------
    case "setImage": {
      const wk = workloadKind(a);
      return [
        "set", "image",
        `${wk}/${target(a)}`,
        `${a.container}=${a.image}`,
        ...ns,
      ];
    }

    // -----------------------------------------------------------------------
    // setResources — set resources <kind>/<name> -c <container>
    //   [--requests=...] [--limits=...] -n <ns>
    // Empty strings are omitted (mirrors Swift guard !requests.isEmpty etc.)
    // -----------------------------------------------------------------------
    case "setResources": {
      const wk = workloadKind(a);
      const args: string[] = ["set", "resources", `${wk}/${target(a)}`, "-c", a.container ?? ""];
      if (a.requests && a.requests !== "") args.push(`--requests=${a.requests}`);
      if (a.limits && a.limits !== "") args.push(`--limits=${a.limits}`);
      args.push(...ns);
      return args;
    }

    // -----------------------------------------------------------------------
    // pod / workload deletion
    // -----------------------------------------------------------------------
    case "deletePod":
      return ["delete", "pod", a.pod ?? "", ...ns];

    case "deleteWorkload": {
      const wk = workloadKind(a);
      return ["delete", wk, target(a), ...ns];
    }

    // -----------------------------------------------------------------------
    // node operations
    // -----------------------------------------------------------------------
    case "cordon":
      return ["cordon", a.node ?? ""];

    case "uncordon":
      return ["uncordon", a.node ?? ""];

    case "drain": {
      // Mirror Swift DrainOptions defaults:
      //   gracePeriodSeconds = -1  (not emitted)
      //   timeout = "0s"           (not emitted — "0s" is skip condition)
      //   ignoreDaemonSets = true  → --ignore-daemonsets
      //   deleteEmptyDirData = true → --delete-emptydir-data
      //   force = false            (not emitted)
      //   disableEviction = false  (not emitted)
      const args = ["drain", a.node ?? ""];
      args.push("--ignore-daemonsets");
      args.push("--delete-emptydir-data");
      return args;
    }

    // -----------------------------------------------------------------------
    // CronJob operations
    // -----------------------------------------------------------------------
    case "suspendCronJob":
      return [
        "patch", "cronjob", target(a),
        ...ns,
        "--type=merge",
        "-p", '{"spec":{"suspend":true}}',
      ];

    case "resumeCronJob":
      return [
        "patch", "cronjob", target(a),
        ...ns,
        "--type=merge",
        "-p", '{"spec":{"suspend":false}}',
      ];

    case "triggerCronJob":
      // Swift uses CronJob.manualRunName(for:); web receives the pre-generated
      // job name in the `pod` field (same wire-format convention as the action block).
      return [
        "create", "job", a.pod ?? `${target(a)}-manual`,
        `--from=cronjob/${target(a)}`,
        ...ns,
      ];

    // -----------------------------------------------------------------------
    // Namespace operations
    // -----------------------------------------------------------------------
    case "createNamespace":
      return ["create", "namespace", target(a)];

    case "deleteNamespace":
      return ["delete", "namespace", target(a)];

    // -----------------------------------------------------------------------
    // deleteResource — mirrors SuggestedActionResolver.resolveDelete
    // -----------------------------------------------------------------------
    case "deleteResource":
      return resolveDeleteResource(a);

    // -----------------------------------------------------------------------
    // linkCatalogApp — annotate <kind>/<name> rigel.dev/catalog-app=<appID>
    //   [rigel.dev/catalog-container=<container>] -n <ns> --overwrite
    // Binds a running workload to a catalog app (docs/parity/catalog-link-workload.md §6.1).
    // --overwrite is REQUIRED so re-pointing an already-bound workload succeeds.
    // -----------------------------------------------------------------------
    case "linkCatalogApp": {
      const wk = workloadKind(a);
      const args = [
        "annotate",
        `${wk}/${target(a)}`,
        `rigel.dev/catalog-app=${a.appID ?? ""}`,
      ];
      if (a.container && a.container !== "") {
        args.push(`rigel.dev/catalog-container=${a.container}`);
      }
      args.push(...ns, "--overwrite");
      return args;
    }

    // -----------------------------------------------------------------------
    // unlinkCatalogApp — annotate <kind>/<name> rigel.dev/catalog-app-
    //   rigel.dev/catalog-container- -n <ns>
    // Removes both binding keys (trailing-dash removal; no --overwrite needed).
    // -----------------------------------------------------------------------
    case "unlinkCatalogApp": {
      const wk = workloadKind(a);
      return [
        "annotate",
        `${wk}/${target(a)}`,
        "rigel.dev/catalog-app-",
        "rigel.dev/catalog-container-",
        ...ns,
      ];
    }

    // -----------------------------------------------------------------------
    // linkSourceRepo — annotate <kind>/<name> rigel.dev/source-repo=<source>
    //   rigel.dev/source-path=<filePath> -n <ns> --overwrite
    // Binds an existing workload to a GitOps source so the AI has source context
    // (and can open fix-PRs). --overwrite re-points an already-linked workload.
    // -----------------------------------------------------------------------
    case "linkSourceRepo": {
      const wk = workloadKind(a);
      return [
        "annotate",
        `${wk}/${target(a)}`,
        `rigel.dev/source-repo=${a.source ?? ""}`,
        `rigel.dev/source-path=${a.filePath ?? "."}`,
        ...ns,
        "--overwrite",
      ];
    }

    // -----------------------------------------------------------------------
    // unlinkSourceRepo — annotate <kind>/<name> rigel.dev/source-repo-
    //   rigel.dev/source-path- -n <ns> (trailing-dash removal)
    // -----------------------------------------------------------------------
    case "unlinkSourceRepo": {
      const wk = workloadKind(a);
      return [
        "annotate",
        `${wk}/${target(a)}`,
        "rigel.dev/source-repo-",
        "rigel.dev/source-path-",
        ...ns,
      ];
    }

    // -----------------------------------------------------------------------
    // setImagePullSecrets — patch spec.template.spec.imagePullSecrets (full
    // desired list). JSON merge patch replaces the array, so detach/clear works
    // by sending a shorter list or [].
    // -----------------------------------------------------------------------
    case "setImagePullSecrets": {
      const wk = workloadKind(a);
      const list = (a.imagePullSecrets ?? []).map((n) => ({ name: n }));
      const patch = JSON.stringify({ spec: { template: { spec: { imagePullSecrets: list } } } });
      return ["patch", `${wk}/${target(a)}`, ...ns, "--type=merge", "-p", patch];
    }

    // -----------------------------------------------------------------------
    // setEnvRef — patch container env vars whose value comes from a Secret or
    // ConfigMap key. Strategic merge keys containers + env by `name`, so it
    // adds/updates only the referenced vars. (kubectl set env can't rename a
    // referenced key, hence the patch.)
    // -----------------------------------------------------------------------
    case "setEnvRef": {
      if (!a.container) throw new Error("setEnvRef requires a container name (strategic-merge key)");
      const wk = workloadKind(a);
      const env = (a.envRefs ?? []).map((r) => ({
        name: r.name,
        valueFrom: r.source === "configMap"
          ? { configMapKeyRef: { name: r.resourceName, key: r.key } }
          : { secretKeyRef: { name: r.resourceName, key: r.key } },
      }));
      const patch = JSON.stringify({ spec: { template: { spec: { containers: [{ name: a.container, env }] } } } });
      return ["patch", `${wk}/${target(a)}`, ...ns, "--type=strategic", "-p", patch];
    }

    // -----------------------------------------------------------------------
    // command — verbatim args (empty strings pre-filtered by Swift, we mirror)
    // -----------------------------------------------------------------------
    case "command":
      return (a.args ?? []).filter((s) => s !== "");

    // -----------------------------------------------------------------------
    // applyManifest — NOT a kubectl argv; manifest is applied via /api/apply
    // -----------------------------------------------------------------------
    case "applyManifest":
      throw new Error("applyManifest is applied via /api/apply (kubectl apply -f -), not /api/action");

    // -----------------------------------------------------------------------
    // purge — NOT a kubectl command; opens typed-name purge confirm sheet
    // -----------------------------------------------------------------------
    case "purge":
      throw new PurgeActionError(target(a));

    // -----------------------------------------------------------------------
    // proposeRepoFix — NOT a kubectl command; opens a PR via /api/git/propose-fix
    // -----------------------------------------------------------------------
    case "proposeRepoFix":
      throw new Error("proposeRepoFix opens a pull request via /api/git/propose-fix, not /api/action");

    // -----------------------------------------------------------------------
    default:
      throw new Error(`unsupported action kind: ${a.kind}`);
  }
}
