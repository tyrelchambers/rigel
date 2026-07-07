// Pure helpers for building an apply-batch ledger from a `kubectl apply`. Kept
// pure (no process spawning) so the ConfigMap manifest + argv are unit-testable;
// the server (install.ts) writes the returned manifest via `kubectl apply -f -`.

import { parseAllDocuments } from "yaml";
import {
  LEDGER_DATA_KEY,
  LEDGER_LABEL_KEY,
  LEDGER_LABEL_VALUE,
  LEDGER_NAMESPACE,
  ledgerName,
  type ApplySource,
} from "./applyBatch";

export interface AppliedResource {
  kind: string; // as written in the manifest, e.g. "Deployment"
  name: string;
  namespace: string | undefined;
}

export interface CreatedResource {
  kind: string; // singular lowercase, e.g. "deployment"
  name: string;
}

export interface LedgerResource {
  kind: string; // manifest kind, e.g. "Deployment"
  name: string;
  namespace: string; // resolved ("default" when the manifest omitted it)
}

export interface LedgerMeta {
  batchId: string;
  appliedAt: string;
  source: ApplySource;
}

export interface LedgerConfigMap {
  apiVersion: "v1";
  kind: "ConfigMap";
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  data: Record<string, string>;
}

/** Parse a multi-doc manifest string into {kind,name,namespace} descriptors. */
export function parseAppliedResources(yaml: string): AppliedResource[] {
  const out: AppliedResource[] = [];
  for (const doc of parseAllDocuments(yaml)) {
    const obj = doc.toJSON() as
      | { kind?: unknown; metadata?: { name?: unknown; namespace?: unknown } }
      | null;
    if (!obj || typeof obj.kind !== "string") continue;
    const name = obj.metadata?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const ns = obj.metadata?.namespace;
    out.push({ kind: obj.kind, name, namespace: typeof ns === "string" ? ns : undefined });
  }
  return out;
}

/**
 * Parse `kubectl apply` stdout, keeping only resources it reported as `created`.
 * Lines look like `deployment.apps/web created` or `service/web created`; the
 * kind is the token before the first `.` or `/`.
 */
export function parseCreatedResources(stdout: string): CreatedResource[] {
  const out: CreatedResource[] = [];
  for (const raw of stdout.split("\n")) {
    const m = /^(\S+?)\/(\S+)\s+created$/.exec(raw.trim());
    if (!m) continue;
    out.push({ kind: m[1]!.split(".")[0]!.toLowerCase(), name: m[2]! });
  }
  return out;
}

/**
 * Join created resources to their manifest entries: keep the manifest kind
 * (e.g. "Deployment") and resolve namespace to the manifest's, or "default" when
 * omitted (the namespace kubectl applied into). Created resources with no
 * matching manifest entry are skipped.
 */
export function resolveCreatedResources(
  created: CreatedResource[],
  applied: AppliedResource[],
): LedgerResource[] {
  const byKey = new Map<string, AppliedResource>();
  for (const r of applied) byKey.set(`${r.kind.toLowerCase()}/${r.name}`, r);

  const out: LedgerResource[] = [];
  for (const c of created) {
    const match = byKey.get(`${c.kind}/${c.name}`);
    if (!match) continue;
    out.push({ kind: match.kind, name: match.name, namespace: match.namespace ?? "default" });
  }
  return out;
}

/**
 * The namespace to co-locate the ledger in: the single namespace shared by all
 * created resources, or LEDGER_NAMESPACE ("default") when a batch spans multiple
 * namespaces or is empty.
 */
export function ledgerNamespaceFor(resources: LedgerResource[]): string {
  const namespaces = new Set(resources.map((r) => r.namespace));
  return namespaces.size === 1 ? [...namespaces][0]! : LEDGER_NAMESPACE;
}

/** Build the ledger ConfigMap manifest for a batch, in the given namespace. */
export function buildLedgerManifest(
  meta: LedgerMeta,
  resources: LedgerResource[],
  namespace: string,
): LedgerConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: ledgerName(meta.batchId),
      namespace,
      labels: { [LEDGER_LABEL_KEY]: LEDGER_LABEL_VALUE },
    },
    data: {
      [LEDGER_DATA_KEY]: JSON.stringify({
        batchId: meta.batchId,
        appliedAt: meta.appliedAt,
        source: meta.source,
        resources,
      }),
    },
  };
}
