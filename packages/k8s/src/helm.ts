// Helm release reading + argv construction, shared by the server (execution)
// and the web app (live release derivation + command preview).
import { gunzipSync, strFromU8 } from "fflate";
import { isValidDNS1123Subdomain } from "./dockerconfigjson";

export interface HelmReleasePayload {
  name: string;
  namespace: string;
  version: number;
  info: {
    status: string;
    first_deployed?: string;
    last_deployed?: string;
    description?: string;
    notes?: string;
  };
  chart: { metadata: { name: string; version: string; appVersion?: string }; values?: unknown };
  config?: unknown;
  manifest?: string;
}

/**
 * Decode a Helm v3 release Secret's `data.release` value. Helm stores the
 * release as base64(gzip(JSON)); Kubernetes then base64-encodes the Secret
 * value again, so the input is double-base64'd. The gzip magic is checked so a
 * (rare) ungzipped payload still decodes. Returns null on any malformed input.
 */
export function decodeReleaseSecret(release: string): HelmReleasePayload | null {
  try {
    const helmB64 = atob(release);               // -> base64(gzip(json))
    const binary = atob(helmB64);                // -> gzip(json) as a binary string
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const json = gzipped ? strFromU8(gunzipSync(bytes)) : strFromU8(bytes);
    return JSON.parse(json) as HelmReleasePayload;
  } catch {
    return null;
  }
}

const RELEASE_SECRET_RE = /^sh\.helm\.release\.v1\.(.+)\.v(\d+)$/;

export interface ReleaseSecret {
  metadata: { name: string; namespace?: string };
  data?: { release?: string };
}

export interface HelmRevision {
  revision: number;
  status: string;
  chartName: string;
  chartVersion: string;
  appVersion?: string;
  updated?: string;
  description?: string;
  manifest?: string;
  config?: unknown;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  currentRevision: number;
  status: string;
  chartName: string;
  chartVersion: string;
  appVersion?: string;
  updated?: string;
  revisions: HelmRevision[];
}

/** Parse a release secret's name into { release, revision }, or null. */
export function parseReleaseSecretName(name: string): { release: string; revision: number } | null {
  const m = name.match(RELEASE_SECRET_RE);
  return m ? { release: m[1]!, revision: Number(m[2]) } : null;
}

/** Collapse `sh.helm.release.v1.*` secrets into releases with newest-first history. */
export function groupReleases(secrets: ReleaseSecret[]): HelmRelease[] {
  const byKey = new Map<string, HelmRevision[]>();
  const ns = new Map<string, string>();
  for (const s of secrets) {
    const parsed = parseReleaseSecretName(s.metadata.name);
    if (!parsed || !s.data?.release) continue;
    const payload = decodeReleaseSecret(s.data.release);
    if (!payload) continue;
    const namespace = s.metadata.namespace ?? payload.namespace;
    const key = `${namespace}/${parsed.release}`;
    ns.set(key, namespace);
    const rev: HelmRevision = {
      revision: parsed.revision,
      status: payload.info.status,
      chartName: payload.chart.metadata.name,
      chartVersion: payload.chart.metadata.version,
      appVersion: payload.chart.metadata.appVersion,
      updated: payload.info.last_deployed,
      description: payload.info.description,
      manifest: payload.manifest,
      config: payload.config,
    };
    const list = byKey.get(key) ?? [];
    list.push(rev);
    byKey.set(key, list);
  }
  const out: HelmRelease[] = [];
  for (const [key, revisions] of byKey) {
    revisions.sort((a, b) => b.revision - a.revision);
    const deployed = revisions.find((r) => r.status === "deployed");
    const current = deployed ?? revisions[0]!;
    out.push({
      name: key.split("/").slice(1).join("/"),
      namespace: ns.get(key)!,
      currentRevision: current.revision,
      status: current.status,
      chartName: current.chartName,
      chartVersion: current.chartVersion,
      appVersion: current.appVersion,
      updated: current.updated,
      revisions,
    });
  }
  return out;
}

export type HelmChartSource =
  | { kind: "repo"; repoName: string; repoURL: string; chart: string; version?: string | null }
  | { kind: "oci"; ref: string; version?: string | null }
  | { kind: "local"; path: string };

export interface HelmInstallOpts {
  releaseName: string;
  namespace: string;
  valuesFile: string;
  context: string | null;
}

function ctxArgs(context: string | null): string[] {
  return context ? ["--kube-context", context] : [];
}

/** The chart reference passed to `helm upgrade --install <name> <ref>`. */
function chartRef(src: HelmChartSource): string {
  if (src.kind === "repo") return `${src.repoName}/${src.chart}`;
  if (src.kind === "oci") return src.ref;
  return src.path;
}

/**
 * Ordered helm command argv arrays (each runs as `helm <argv>`). Repo sources
 * emit repo add + repo update before the upgrade; oci/local emit only upgrade.
 */
export function buildHelmInstallCommands(src: HelmChartSource, o: HelmInstallOpts): string[][] {
  const version = src.kind !== "local" && src.version ? ["--version", src.version] : [];
  // The `--` terminator ends option parsing so the release name and chart ref
  // can never be interpreted as helm flags (e.g. an injected `--post-renderer`
  // or `--kubeconfig`), even for a caller that skips validateHelmInstall. All
  // real flags must therefore precede it.
  const upgrade = [
    "upgrade", "--install", ...version,
    "-n", o.namespace, "--create-namespace", "-f", o.valuesFile, ...ctxArgs(o.context),
    "--", o.releaseName, chartRef(src),
  ];
  if (src.kind === "repo") {
    return [["repo", "add", "--", src.repoName, src.repoURL], ["repo", "update", "--", src.repoName], upgrade];
  }
  return [upgrade];
}

export function buildHelmRollbackArgs(release: string, revision: number, namespace: string, context: string | null): string[] {
  return ["rollback", "-n", namespace, ...ctxArgs(context), "--", release, String(revision)];
}

export function buildHelmUninstallArgs(release: string, namespace: string, context: string | null): string[] {
  return ["uninstall", "-n", namespace, ...ctxArgs(context), "--", release];
}

// ---------------------------------------------------------------------------
// Input validation — the server boundary for user-controlled helm fields.
//
// helm uses cobra/pflag, which intersperse flags and positionals, so a value
// that begins with `-` is parsed as a flag rather than as data. Flags like
// `--kubeconfig` (exec credential plugin) and `--post-renderer` lead to
// arbitrary command execution, so every field that lands in a helm argv must be
// validated before execution. Pure + exported so the server can reject with a
// 422 and tests can cover it directly.
// ---------------------------------------------------------------------------

/**
 * A helm argv value is unsafe when it is empty or begins with `-`: such a value
 * would be parsed by helm/pflag as a flag instead of as a positional/value.
 */
export function isSafeHelmArg(value: string): boolean {
  return value.length > 0 && !value.startsWith("-");
}

/** A chart-repo URL must be http(s); rejects `file://`, `-`-prefixed, junk. */
export function isHttpRepoURL(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validate a release name + namespace before they reach `helm` (rollback,
 * uninstall, install). Both must be DNS-1123 subdomains, which also forbids the
 * leading `-` that would let them be parsed as helm flags. Returns an error
 * message, or null when safe.
 */
export function validateHelmTarget(release: string, namespace: string): string | null {
  if (!isValidDNS1123Subdomain(release)) return "release name must be a valid DNS-1123 name";
  if (!isValidDNS1123Subdomain(namespace)) return "namespace must be a valid DNS-1123 name";
  return null;
}

/**
 * Validate the user-controlled fields of a Helm install/upgrade request.
 * Returns an error message, or null when the request is safe to execute.
 */
export function validateHelmInstall(src: HelmChartSource, releaseName: string, namespace: string): string | null {
  const nameErr = validateHelmTarget(releaseName, namespace);
  if (nameErr) return nameErr;
  if (src.kind !== "local" && src.version != null && src.version !== "" && !isSafeHelmArg(src.version)) {
    return "chart version is invalid";
  }
  if (src.kind === "repo") {
    if (!isSafeHelmArg(src.repoName)) return "repo name is invalid";
    if (!isSafeHelmArg(src.chart)) return "chart name is invalid";
    if (!isHttpRepoURL(src.repoURL)) return "repo URL must be an http(s) URL";
    return null;
  }
  if (src.kind === "oci") {
    if (!src.ref.startsWith("oci://")) return "OCI ref must start with oci://";
    return null;
  }
  if (!isSafeHelmArg(src.path)) return "chart path is invalid";
  return null;
}
