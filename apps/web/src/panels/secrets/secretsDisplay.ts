import type { Secret } from "@rigel/k8s";

/**
 * Pure display helpers for the Secrets panel. Mirrors the Swift `Secret`
 * computed properties (`keyCount`, `keysSorted`, `rawBytes`, `decoded`) and the
 * `SecretType.displayName` enum, plus `SecretsViewModel.filteredSecrets`.
 * See `docs/parity/secrets.md`.
 *
 * Reveal is purely client-side: values arrive base64-encoded on the watch
 * stream and are decoded in the browser on explicit user action — never on a
 * server round-trip, and never searched (values are sensitive).
 */

// Re-export the shared relativeAge so the panel imports one age formatter.
export { relativeAge } from "../pods/podDisplay";

/**
 * Number of data keys. Mirrors Swift `keyCount = data?.count ?? 0`.
 * Secrets have no separate `binaryData` field — all values live in `data`.
 */
export function keyCount(secret: Secret): number {
  return Object.keys(secret.data ?? {}).length;
}

/**
 * All data keys sorted alphabetically for stable display. Mirrors Swift
 * `keysSorted = (data ?? [:]).keys.sorted()`.
 */
export function keysSorted(secret: Secret): string[] {
  return Object.keys(secret.data ?? {}).sort((a, b) => a.localeCompare(b));
}

/**
 * Display name for a raw secret type string. Mirrors the Swift
 * `SecretType.displayName`. Unknown types fall back to "Other".
 */
export function secretTypeDisplayName(rawType?: string): string {
  switch (rawType) {
    case undefined:
    case "":
    case "Opaque":
      return "Opaque";
    case "kubernetes.io/dockerconfigjson":
      return "Docker registry";
    case "kubernetes.io/tls":
      return "TLS";
    case "kubernetes.io/basic-auth":
      return "Basic auth";
    case "kubernetes.io/ssh-auth":
      return "SSH auth";
    case "kubernetes.io/service-account-token":
      return "Service-account token";
    default:
      return "Other";
  }
}

/**
 * Decode the base64 value of a key into a UTF-8 string. Returns `null` when the
 * bytes are not valid UTF-8 (binary), mirroring Swift
 * `String(data:encoding:.utf8)` returning nil. Also returns `null` on malformed
 * base64.
 */
export function decoded(secret: Secret, key: string): string | null {
  const base64 = secret.data?.[key];
  if (base64 == null) return null;
  const bytes = decodeBase64(base64);
  if (bytes == null) return null;
  try {
    // `fatal: true` throws on invalid UTF-8, matching Swift's nil-on-binary.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decoded (raw) byte count of a key's base64 value. Mirrors Swift
 * `Data(base64Encoded:)?.count ?? 0`. Returns 0 on malformed base64.
 */
export function rawBytes(secret: Secret, key: string): number {
  const base64 = secret.data?.[key];
  if (base64 == null) return 0;
  return decodeBase64(base64)?.length ?? 0;
}

/**
 * Case-insensitive substring match across name, namespace, type (raw + display
 * name), and all data key names. Empty/blank query matches everything.
 *
 * NEVER matches decoded values — secret values are sensitive and hidden by
 * default, so search must not expose them. Mirrors
 * `SecretsViewModel.filteredSecrets` (name/namespace/type) extended with key
 * names per the spec.
 */
export function matchesSearch(secret: Secret, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;

  const fields: string[] = [
    secret.metadata.name,
    secret.metadata.namespace ?? "",
    secret.type ?? "",
    secretTypeDisplayName(secret.type),
    ...keysSorted(secret),
  ];

  return fields.some((f) => f.toLowerCase().includes(q));
}

/** Stable display sort: namespace, then name. */
export function sortSecrets(secrets: Secret[]): Secret[] {
  return [...secrets].sort((a, b) => {
    const ns = (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "");
    if (ns !== 0) return ns;
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}

/**
 * Decode a base64 string (tolerating embedded whitespace/newlines kubectl may
 * include) into raw bytes. Returns `null` on malformed input, mirroring Swift's
 * `Data(base64Encoded:)` returning nil.
 */
function decodeBase64(base64: string): Uint8Array | null {
  const s = base64.replace(/\s/g, "");
  if (s.length === 0) return new Uint8Array(0);
  if (s.length % 4 !== 0) return null; // malformed → mirror Swift's nil
  try {
    const binary = atob(s);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
