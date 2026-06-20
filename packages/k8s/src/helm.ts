// Helm release reading + argv construction, shared by the server (execution)
// and the web app (live release derivation + command preview).
import { gunzipSync, strFromU8 } from "fflate";

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
    const json = gzipped ? strFromU8(gunzipSync(bytes)) : binary;
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
