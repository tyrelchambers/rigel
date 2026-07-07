// The apply-batch ledger: Rigel records each manifest apply as ONE ConfigMap so
// "Recent deployments" can list it and Undo can delete exactly what the apply
// created. Constants centralized here (one place per contract string), mirroring
// catalog's CATALOG_APP_ANNOTATION convention. Placed in @rigel/k8s (not catalog)
// because they are not catalog-specific.

/** Label selecting ledger ConfigMaps. */
export const LEDGER_LABEL_KEY = "rigel.dev/ledger";
export const LEDGER_LABEL_VALUE = "apply-batch";
/** Ledger ConfigMap name = prefix + batchId. */
export const LEDGER_NAME_PREFIX = "rigel-apply-";
/** The ConfigMap data key holding the batch JSON. */
export const LEDGER_DATA_KEY = "batch.json";
/** Rigel's standard state namespace; used as the ledger namespace fallback. */
export const LEDGER_NAMESPACE = "default";

/** The Rigel apply surfaces that record a batch. */
export type ApplySource = "compose-migration" | "catalog-install" | "apply-yaml";

const APPLY_SOURCES: readonly ApplySource[] = [
  "compose-migration",
  "catalog-install",
  "apply-yaml",
];

/** Ledger ConfigMap name for a batch id. */
export function ledgerName(batchId: string): string {
  return `${LEDGER_NAME_PREFIX}${batchId}`;
}

/** Narrow an arbitrary string to a valid ApplySource, or null. */
export function asApplySource(v: string | undefined | null): ApplySource | null {
  return v != null && (APPLY_SOURCES as readonly string[]).includes(v) ? (v as ApplySource) : null;
}
