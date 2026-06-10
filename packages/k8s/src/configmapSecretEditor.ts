import type { ConfigMap, Secret } from "./index";
import { base64Encode, buildDockerConfigJson } from "./dockerconfigjson";

/**
 * Pure CREATE/EDIT logic for ConfigMaps and Secrets. Mirrors the Swift
 * `ConfigMap`/`Secret` `draft()` + `toYAML()` builders and the
 * `ConfigMapEditorSheet`/`SecretEditorSheet` validation, so the web editors
 * produce byte-for-byte equivalent manifests for `kubectl apply -f -`.
 * See `docs/parity/configmap-secret-edit.md`.
 *
 * Everything testable lives here; the React editors stay thin shells. No new
 * npm dependencies — the YAML emitter is hand-rolled to match Yams' block-scalar
 * output for multi-line ConfigMap values while keeping Secret data on one line.
 */

// ---------------------------------------------------------------------------
// Secret types — mirrors the Swift `SecretType` enum.
// ---------------------------------------------------------------------------

/** Built-in Kubernetes secret types we render type-aware editors for. */
export type SecretTypeId =
  | "Opaque"
  | "kubernetes.io/dockerconfigjson"
  | "kubernetes.io/tls"
  | "kubernetes.io/basic-auth"
  | "kubernetes.io/ssh-auth";

/** Descriptor for a creatable secret type. */
export interface SecretTypeInfo {
  id: SecretTypeId;
  displayName: string;
  /** Canonical data keys pre-populated + required for this type. */
  canonicalKeys: string[];
}

/**
 * The secret types the New-secret form exposes, in display order. Mirrors
 * `SecretType.allCases.filter { $0.isUserCreatable }` (Opaque first, then the
 * canonical-key types). Service-account-token and "other" are not creatable.
 */
export const CREATABLE_SECRET_TYPES: SecretTypeInfo[] = [
  { id: "Opaque", displayName: "Opaque", canonicalKeys: [] },
  {
    id: "kubernetes.io/dockerconfigjson",
    displayName: "Docker registry",
    canonicalKeys: [".dockerconfigjson"],
  },
  { id: "kubernetes.io/tls", displayName: "TLS", canonicalKeys: ["tls.crt", "tls.key"] },
  {
    id: "kubernetes.io/basic-auth",
    displayName: "Basic auth",
    canonicalKeys: ["username", "password"],
  },
  { id: "kubernetes.io/ssh-auth", displayName: "SSH auth", canonicalKeys: ["ssh-privatekey"] },
];

/** Canonical data keys for a secret type id (empty for Opaque / unknown). */
export function canonicalKeysFor(type: SecretTypeId): string[] {
  return CREATABLE_SECRET_TYPES.find((t) => t.id === type)?.canonicalKeys ?? [];
}

/**
 * Normalize a raw secret type string to a creatable `SecretTypeId`, defaulting
 * to Opaque for absent/empty/unknown types. Mirrors `SecretType(rawType:)`
 * collapsing to `.opaque` (we only edit creatable types; unknown → Opaque).
 */
export function secretTypeId(rawType?: string): SecretTypeId {
  if (rawType == null || rawType === "" || rawType === "Opaque") return "Opaque";
  const match = CREATABLE_SECRET_TYPES.find((t) => t.id === rawType);
  return match ? match.id : "Opaque";
}

// ---------------------------------------------------------------------------
// base64 round-trip for Secret values (re-exported under the spec's names).
// ---------------------------------------------------------------------------

/** Base64-encode a plaintext secret value (UTF-8 safe). Mirrors `btoa()`. */
export function encodeSecretValue(plaintext: string): string {
  return base64Encode(plaintext);
}

/**
 * Decode a base64 secret value to a UTF-8 string, or `null` when the bytes are
 * not valid UTF-8 (binary) or the base64 is malformed. Mirrors Swift
 * `secret.decoded(key)` returning nil on binary.
 */
export function decodeSecretValue(base64: string): string | null {
  const s = base64.replace(/\s/g, "");
  if (s.length % 4 !== 0) return null; // malformed → nil
  let binary: string;
  try {
    binary = atob(s);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  try {
    // `fatal: true` throws on invalid UTF-8 → null, matching Swift's nil-on-binary.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Decoded byte count of a base64 value (0 on malformed). For `<binary, N bytes>`. */
export function decodedByteLength(base64: string): number {
  const s = base64.replace(/\s/g, "");
  if (s.length === 0) return 0;
  if (s.length % 4 !== 0) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - padding;
}

// ---------------------------------------------------------------------------
// Validation — mirrors the Swift `canSubmit` gates. DNS-1123 is intentionally
// NOT enforced here: the Swift editors require only a non-empty trimmed name.
// ---------------------------------------------------------------------------

/** A ConfigMap/Secret name is valid when non-empty after trimming. */
export function validateConfigMapName(name: string): boolean {
  return name.trim().length > 0;
}

/** Same minimum as ConfigMap — non-empty after trimming. */
export function validateSecretName(name: string): boolean {
  return name.trim().length > 0;
}

/** One key/value row in an editor. */
export interface KVRow {
  /** Stable client id so React keys survive reorders. */
  id: string;
  key: string;
  value: string;
  /** Edit-only: a binary secret value that can't be re-encoded (read-only). */
  binary?: { bytes: number };
}

/**
 * ConfigMap submit gate (mirrors `ConfigMapEditorSheet.canSubmit`): non-empty
 * trimmed name AND no duplicate keys among the non-empty-key rows. Values may be
 * empty. Namespace is required by the panel default ("default") but the Swift
 * gate does not re-check it; we add the non-empty namespace check to match the
 * spec ("name required non-empty, namespace required").
 */
export function canSubmitConfigMap(
  name: string,
  namespace: string,
  rows: KVRow[],
): boolean {
  if (name.trim().length === 0) return false;
  if (namespace.trim().length === 0) return false;
  const keys = rows
    .map((r) => r.key.trim())
    .filter((k) => k.length > 0);
  return new Set(keys).size === keys.length;
}

/**
 * Secret submit gate (mirrors `SecretEditorSheet.canSubmit`): non-empty trimmed
 * name + namespace; Docker registry needs server/user/pass; other canonical
 * types need all their pinned keys to have non-empty values; Opaque needs at
 * least one non-empty key. Also rejects duplicate Opaque keys (spec: unique
 * keys). Binary read-only rows count as having a value (carried unchanged).
 */
export function canSubmitSecret(
  name: string,
  namespace: string,
  type: SecretTypeId,
  rows: KVRow[],
  docker: DockerCredsForm,
): boolean {
  if (name.trim().length === 0) return false;
  if (namespace.trim().length === 0) return false;

  if (type === "kubernetes.io/dockerconfigjson") {
    return (
      docker.server.trim().length > 0 &&
      docker.username.trim().length > 0 &&
      docker.password.length > 0
    );
  }

  const pinned = canonicalKeysFor(type);
  if (pinned.length > 0) {
    return pinned.every((k) => {
      const row = rows.find((r) => r.key === k);
      if (!row) return false;
      if (row.binary) return true; // carried unchanged
      return row.value.length > 0;
    });
  }

  // Opaque: at least one non-empty key, and no duplicate keys.
  const keys = rows.map((r) => r.key.trim()).filter((k) => k.length > 0);
  if (keys.length === 0) return false;
  return new Set(keys).size === keys.length;
}

// ---------------------------------------------------------------------------
// Docker registry assembly — mirrors `SecretEditorSheet.dockerConfigJSONPayload`.
// ---------------------------------------------------------------------------

export interface DockerCredsForm {
  server: string;
  username: string;
  password: string;
  email: string;
}

export function emptyDockerCreds(): DockerCredsForm {
  return { server: "", username: "", password: "", email: "" };
}

/**
 * Build the base64-encoded `.dockerconfigjson` value from the four-field form.
 * Assembles `{auths:{server:{username,password,auth:base64(user:pass),email?}}}`
 * then base64-encodes the JSON. Delegates to the shared `buildDockerConfigJson`
 * so the `auth` field + Docker Hub host normalization stay identical to Accounts.
 */
export function encodeDockerConfigJson(docker: DockerCredsForm): string {
  const email = docker.email.trim();
  return buildDockerConfigJson(
    docker.server.trim(),
    docker.username.trim(),
    docker.password,
    email === "" ? undefined : email,
  );
}

/**
 * Parse a decoded `.dockerconfigjson` payload back into the four-field form for
 * EDIT mode. Picks the first `auths` entry. Returns `null` on malformed input.
 * Mirrors `SecretEditorSheet.parseDockerConfigJSON`.
 */
export function parseDockerCredsForm(payload: string): DockerCredsForm | null {
  let root: unknown;
  try {
    root = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof root !== "object" || root === null) return null;
  const auths = (root as { auths?: unknown }).auths;
  if (typeof auths !== "object" || auths === null) return null;
  const entries = Object.entries(auths as Record<string, unknown>);
  if (entries.length === 0) return null;
  const [server, rawEntry] = entries[0]!;
  const entry = (typeof rawEntry === "object" && rawEntry !== null
    ? (rawEntry as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  return {
    server,
    username: typeof entry.username === "string" ? entry.username : "",
    password: typeof entry.password === "string" ? entry.password : "",
    email: typeof entry.email === "string" ? entry.email : "",
  };
}

// ---------------------------------------------------------------------------
// YAML emitters — hand-rolled, no deps.
// ---------------------------------------------------------------------------

/**
 * Quote a scalar with single quotes, doubling embedded single quotes. Matches
 * the Swift `Secret.yamlScalar` — safe for keys with dots, base64 `=`, and
 * arbitrary user input without per-character escaping.
 */
function yamlSingleQuoted(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Emit a `key: value` ConfigMap data entry. Single-line values are single-quoted
 * scalars; multi-line values use a literal block scalar (`|`) so whole config
 * files round-trip — this matches what Yams emits for multi-line strings, which
 * is the only behavior `kubectl apply` cares about. A clip indicator (`|-`/`|`)
 * is chosen by trailing-newline presence so the value reads back identically.
 */
function configMapDataEntry(key: string, value: string, indent: string): string {
  const quotedKey = yamlSingleQuoted(key);
  if (!value.includes("\n")) {
    return `${indent}${quotedKey}: ${yamlSingleQuoted(value)}`;
  }
  // Literal block scalar. Choose the chomping indicator from trailing newlines:
  //   - exactly one trailing "\n"  → clip (default, "|")
  //   - no trailing newline         → strip ("|-")
  //   - 2+ trailing newlines        → keep ("|+")
  const trailing = value.length - value.replace(/\n+$/, "").length;
  const indicator = trailing === 0 ? "|-" : trailing >= 2 ? "|+" : "|";
  const body = trailing === 0 ? value : value.replace(/\n+$/, "");
  const lines = body.split("\n").map((l) => `${indent}  ${l}`);
  return [`${indent}${quotedKey}: ${indicator}`, ...lines].join("\n");
}

/**
 * Build ConfigMap YAML for `kubectl apply -f -`. Mirrors `ConfigMap.draft()` +
 * `ConfigMap.toYAML()` (sorted keys, multi-line block scalars, `binaryData`
 * preserved verbatim). Empty `data`/`binaryData` maps are omitted.
 */
export function buildConfigMapYAML(
  name: string,
  namespace: string,
  data: Record<string, string>,
  binaryData?: Record<string, string>,
  labels?: Record<string, string>,
): string {
  const lines: string[] = ["apiVersion: v1", "kind: ConfigMap", "metadata:"];
  lines.push(`  name: ${yamlSingleQuoted(name)}`);
  if (namespace.trim() !== "") lines.push(`  namespace: ${yamlSingleQuoted(namespace)}`);
  if (labels && Object.keys(labels).length > 0) {
    lines.push("  labels:");
    for (const k of Object.keys(labels).sort()) {
      lines.push(`    ${yamlSingleQuoted(k)}: ${yamlSingleQuoted(labels[k]!)}`);
    }
  }

  const dataKeys = Object.keys(data).sort();
  if (dataKeys.length > 0) {
    lines.push("data:");
    for (const k of dataKeys) lines.push(configMapDataEntry(k, data[k]!, "  "));
  }

  const binKeys = binaryData ? Object.keys(binaryData).sort() : [];
  if (binKeys.length > 0) {
    lines.push("binaryData:");
    for (const k of binKeys) {
      lines.push(`  ${yamlSingleQuoted(k)}: ${yamlSingleQuoted(binaryData![k]!)}`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Build Secret YAML for `kubectl apply -f -`. Mirrors `Secret.draft()` +
 * `Secret.toYAML()`: plaintext `decodedData` values are base64-encoded into the
 * `data` field (never `stringData`), keys sorted, `type` included (Opaque when
 * absent), all scalars single-quoted. `preEncodedData` carries values that are
 * already base64 (binary values preserved unchanged on EDIT, or the
 * Docker-registry `.dockerconfigjson` blob).
 */
export function buildSecretYAML(
  name: string,
  namespace: string,
  type: SecretTypeId,
  decodedData: Record<string, string>,
  preEncodedData: Record<string, string> = {},
  labels?: Record<string, string>,
): string {
  const encoded: Record<string, string> = {};
  for (const [k, v] of Object.entries(decodedData)) encoded[k] = encodeSecretValue(v);
  for (const [k, v] of Object.entries(preEncodedData)) encoded[k] = v;

  const lines: string[] = ["apiVersion: v1", "kind: Secret", "metadata:"];
  lines.push(`  name: ${yamlSingleQuoted(name)}`);
  if (namespace.trim() !== "") lines.push(`  namespace: ${yamlSingleQuoted(namespace)}`);
  if (labels && Object.keys(labels).length > 0) {
    lines.push("  labels:");
    for (const k of Object.keys(labels).sort()) {
      lines.push(`    ${yamlSingleQuoted(k)}: ${yamlSingleQuoted(labels[k]!)}`);
    }
  }
  lines.push(`type: ${yamlSingleQuoted(type)}`);

  const keys = Object.keys(encoded).sort();
  if (keys.length > 0) {
    lines.push("data:");
    for (const k of keys) lines.push(`  ${yamlSingleQuoted(k)}: ${yamlSingleQuoted(encoded[k]!)}`);
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Seeding editor rows from existing resources (EDIT mode).
// ---------------------------------------------------------------------------

let rowCounter = 0;
/** Allocate a stable client row id. */
export function newRowId(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

/** A blank editable row. */
export function blankRow(): KVRow {
  return { id: newRowId(), key: "", value: "" };
}

/**
 * Seed ConfigMap editor rows from an existing ConfigMap's plaintext `data`
 * (sorted). Binary data is NOT seeded — it is carried through unchanged via
 * `binaryData`. Returns `[blankRow()]` when there is no plaintext data.
 */
export function seedConfigMapRows(cm: ConfigMap): KVRow[] {
  const data = cm.data ?? {};
  const keys = Object.keys(data).sort();
  if (keys.length === 0) return [blankRow()];
  return keys.map((k) => ({ id: newRowId(), key: k, value: data[k]! }));
}

/**
 * Seed Secret editor rows from an existing Secret (sorted keys). Decodable
 * UTF-8 values are pre-filled; binary values become read-only rows tagged with
 * their byte count (shown as `<binary, N bytes>`, not re-editable). Returns
 * `[blankRow()]` when the Secret has no data.
 */
export function seedSecretRows(secret: Secret): KVRow[] {
  const data = secret.data ?? {};
  const keys = Object.keys(data).sort();
  if (keys.length === 0) return [blankRow()];
  return keys.map((k) => {
    const b64 = data[k]!;
    const decoded = decodeSecretValue(b64);
    if (decoded == null) {
      return { id: newRowId(), key: k, value: "", binary: { bytes: decodedByteLength(b64) } };
    }
    return { id: newRowId(), key: k, value: decoded };
  });
}

/**
 * Collapse ConfigMap editor rows into the plaintext `data` map sent to
 * `buildConfigMapYAML`: trim keys, drop empty-key rows, last write wins.
 * Mirrors `ConfigMapEditorSheet.buildConfigMap`.
 */
export function rowsToConfigMapData(rows: KVRow[]): Record<string, string> {
  const data: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (key === "") continue;
    data[key] = r.value;
  }
  return data;
}
