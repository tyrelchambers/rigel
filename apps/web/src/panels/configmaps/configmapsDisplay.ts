import type { ConfigMap } from "./types";

/**
 * Pure display helpers for the ConfigMaps panel. Mirrors the Swift `ConfigMap`
 * computed properties (`keyCount`, `keysSorted`, `binaryBytes`) and
 * `ConfigMapsViewModel.filteredConfigMaps`. See `docs/parity/configmaps.md`.
 */

// Re-export the shared age formatters so the panel imports one of each.
export { relativeAge, humanAge } from "../pods/podDisplay";

/** Detected value kind for a plaintext ConfigMap key (drives the type badge). */
export type ValueKind = "certificate" | "json" | "yaml" | "text";

/**
 * Human-readable byte size: "566 B", "1.5 KB", "2 MB". Whole values drop the
 * decimal ("1 KB", not "1.0 KB"); ≥10 of a unit rounds to an integer.
 */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const rounded = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/**
 * Lightweight ("Medium") value-kind detection for the key preview badge:
 *   - `certificate` — value contains a PEM certificate header.
 *   - `json` — trimmed value starts with `{`/`[` and parses as JSON.
 *   - `yaml` — key ends `.yaml`/`.yml` (extension heuristic, no structural parse).
 *   - `text` — anything else.
 * No deep format parsing (that would be the "Full" tier).
 */
export function valueKind(key: string, value: string): ValueKind {
  if (value.includes("-----BEGIN CERTIFICATE-----")) return "certificate";
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(value);
      return "json";
    } catch {
      // not valid JSON — fall through to the extension/text checks
    }
  }
  const lower = key.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return "text";
}

/** Uppercase badge label for a value kind. */
export function kindLabel(kind: ValueKind): string {
  switch (kind) {
    case "certificate":
      return "CERTIFICATE";
    case "json":
      return "JSON";
    case "yaml":
      return "YAML";
    default:
      return "TEXT";
  }
}

/**
 * Split a value into display lines, dropping a single trailing newline so a
 * value ending in "\n" counts as N lines, not N+1. An empty string is one
 * (empty) line.
 */
export function valueLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Deterministic namespace → dot color. Mirrors the design's per-namespace
// identity dot; the app has no shared namespace-color helper, so this is a small
// self-contained hash into a fixed palette (matches the Pencil pod.color set).
const NS_DOT_PALETTE = [
  "#60A5FA",
  "#34D399",
  "#FB923C",
  "#A855F7",
  "#EC4899",
  "#22D3EE",
  "#FACC15",
  "#2DD4BF",
];

/** Stable color for a namespace's identity dot (same ns → same color). */
export function namespaceDotColor(ns: string): string {
  let h = 0;
  for (let i = 0; i < ns.length; i += 1) h = (h * 31 + ns.charCodeAt(i)) >>> 0;
  return NS_DOT_PALETTE[h % NS_DOT_PALETTE.length];
}

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
