import type { ConfigMap } from "./types";

/**
 * Pure display helpers for the ConfigMaps panel. Mirrors the Swift `ConfigMap`
 * computed properties (`keyCount`, `keysSorted`, `binaryBytes`) and
 * `ConfigMapsViewModel.filteredConfigMaps`. See `docs/parity/configmaps.md`.
 */

// Re-export the shared relativeAge so the panel imports one age formatter.
export { relativeAge } from "../pods/podDisplay";

/**
 * Total key count across plaintext + binary data. Mirrors Swift
 * `keyCount = (data?.count ?? 0) + (binaryData?.count ?? 0)`.
 */
export function keyCount(cm: ConfigMap): number {
  return Object.keys(cm.data ?? {}).length + Object.keys(cm.binaryData ?? {}).length;
}

/** Number of binary keys (0 when `binaryData` is empty/absent). */
export function binaryKeyCount(cm: ConfigMap): number {
  return Object.keys(cm.binaryData ?? {}).length;
}

/**
 * All keys across `data` and `binaryData`, deduped and sorted alphabetically.
 * Mirrors Swift `keysSorted = Set(data.keys).union(binaryData.keys).sorted()`.
 */
export function keysSorted(cm: ConfigMap): string[] {
  const set = new Set<string>([
    ...Object.keys(cm.data ?? {}),
    ...Object.keys(cm.binaryData ?? {}),
  ]);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** True when the key is present in `binaryData`. */
export function isBinaryKey(cm: ConfigMap, key: string): boolean {
  return cm.binaryData != null && key in cm.binaryData;
}

/**
 * UTF-8 byte length of a plaintext value (e.g. "hello" => 5). Mirrors the
 * Swift `value.utf8.count` used for plaintext size badges.
 */
export function plaintextBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Decoded byte count of a base64 `binaryData` value. Mirrors Swift
 * `Data(base64Encoded:)?.count ?? 0`. Returns 0 on malformed base64.
 */
export function binaryBytes(base64: string): number {
  // Strip whitespace/newlines kubectl may include, then compute the decoded
  // length from the base64 string without materializing the bytes.
  const s = base64.replace(/\s/g, "");
  if (s.length === 0) return 0;
  if (s.length % 4 !== 0) return 0; // malformed → mirror Swift's nil → 0
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - padding;
}

/**
 * Case-insensitive substring match across name, namespace, and all key names
 * in `data` + `binaryData`. Empty/blank query matches everything. Mirrors
 * `ConfigMapsViewModel.filteredConfigMaps` whose `matches` closure checks
 * `keysSorted.contains { $0.localizedCaseInsensitiveContains(q) }` on top of
 * the cache's default name/namespace match.
 */
export function matchesSearch(cm: ConfigMap, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;

  const fields: string[] = [
    cm.metadata.name,
    cm.metadata.namespace ?? "",
    ...keysSorted(cm),
  ];

  return fields.some((f) => f.toLowerCase().includes(q));
}

/** Stable display sort: namespace, then name. */
export function sortConfigMaps(configMaps: ConfigMap[]): ConfigMap[] {
  return [...configMaps].sort((a, b) => {
    const ns = (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "");
    if (ns !== 0) return ns;
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}
