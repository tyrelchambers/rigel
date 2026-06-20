import type { Secret } from "./index";

/**
 * Pure builder + parser for kubernetes.io/dockerconfigjson image-pull Secrets.
 * Mirrors the Swift `RegistryCredentialBuilder` precedent (Docker Hub host
 * normalization, base64 `auth` field) so the Accounts panel produces byte-for-
 * byte equivalent Secrets across both apps. See `docs/parity/accounts.md`.
 *
 * SECURITY: nothing here logs. Passwords flow through `buildDockerConfigJson`
 * /`dockerconfigjsonToSecret` only to be base64-encoded into the Secret payload.
 * The YAML preview the UI shows must mask `.dockerconfigjson` as `[hidden]`
 * (see `secretPreviewYAML`) — these builders never emit a "preview" variant
 * that would leak the credential.
 */

export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const MANAGED_BY_VALUE = "rigel";
export const DOCKERCONFIGJSON_TYPE = "kubernetes.io/dockerconfigjson";
export const DOCKERCONFIGJSON_KEY = ".dockerconfigjson";

/**
 * Canonical Docker Hub registry key. Docker Hub aliases (`docker.io`,
 * `index.docker.io`, `registry-1.docker.io`, with or without scheme/`/v1/`)
 * are all normalized to this so a single Secret authenticates Hub pulls.
 */
export const DOCKER_HUB_KEY = "https://index.docker.io/v1/";

export interface RegistryCredential {
  registry: string;
  username: string;
  password: string;
  email?: string;
}

export interface DockerConfigJsonAuth {
  username: string;
  password: string;
  auth: string;
  email?: string;
}

export interface DockerConfigJsonData {
  auths: Record<string, DockerConfigJsonAuth>;
}

/** A Kubernetes Secret manifest carrying a dockerconfigjson payload. */
export interface KubernetesSecret extends Secret {
  apiVersion: "v1";
  kind: "Secret";
}

// ---------------------------------------------------------------------------
// base64 — works in both the browser (web panel) and bun/node (tests/server).
// btoa/atob operate on Latin-1, so we round-trip UTF-8 bytes explicitly to keep
// non-ASCII usernames/tokens intact.
// ---------------------------------------------------------------------------

/** Base64-encode a UTF-8 string. */
export function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** Base64-decode to a UTF-8 string. Returns `null` on malformed input. */
export function base64Decode(input: string): string | null {
  const s = input.replace(/\s/g, "");
  try {
    const binary = atob(s);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Normalize a registry hostname to its dockerconfigjson auth key. Docker Hub
 * and its aliases collapse to `https://index.docker.io/v1/`; every other host
 * is used verbatim (trimmed). Mirrors the Swift Docker Hub quirk.
 */
export function normalizeRegistryKey(registry: string): string {
  const trimmed = registry.trim();
  // Strip scheme + any trailing path/slashes to get a bare host for comparison.
  const bare = trimmed
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (
    bare === "docker.io" ||
    bare === "index.docker.io" ||
    bare === "registry-1.docker.io"
  ) {
    return DOCKER_HUB_KEY;
  }
  return trimmed;
}

/**
 * Build the base64-encoded `.dockerconfigjson` value for a single registry
 * credential. The inner `auth` field is `base64(username:password)`, as the
 * Docker CLI and kubelet expect.
 */
export function buildDockerConfigJson(
  registry: string,
  username: string,
  password: string,
  email?: string,
): string {
  const auths = buildAuths([{ registry, username, password, email }]);
  return base64Encode(JSON.stringify({ auths }));
}

/**
 * Merge multiple registry credentials into a single `.dockerconfigjson`
 * `auths` map (one Secret can authenticate several registries). Later entries
 * for the same normalized key win.
 */
export function buildAuths(
  creds: RegistryCredential[],
): DockerConfigJsonData["auths"] {
  const auths: DockerConfigJsonData["auths"] = {};
  for (const c of creds) {
    const key = normalizeRegistryKey(c.registry);
    const entry: DockerConfigJsonAuth = {
      username: c.username,
      password: c.password,
      auth: base64Encode(`${c.username}:${c.password}`),
    };
    if (c.email && c.email.trim() !== "") entry.email = c.email;
    auths[key] = entry;
  }
  return auths;
}

/**
 * Assemble a complete dockerconfigjson Secret manifest object for a single
 * credential. The `.dockerconfigjson` value is base64-encoded (unmasked) —
 * callers serialize this to YAML for `/api/apply`. For the on-screen preview,
 * use `secretPreviewYAML`, which masks the credential.
 */
export function dockerconfigjsonToSecret(
  registry: string,
  username: string,
  password: string,
  secretName: string,
  namespace: string,
  email?: string,
): KubernetesSecret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace,
      uid: "", // assigned by the API server; absent at apply time
      labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
    },
    type: DOCKERCONFIGJSON_TYPE,
    data: {
      [DOCKERCONFIGJSON_KEY]: buildDockerConfigJson(registry, username, password, email),
    },
  };
}

/** Parse a `.dockerconfigjson` JSON string into its `auths` map. Throws on bad JSON. */
export function parseDockerConfigJson(jsonString: string): DockerConfigJsonData {
  const parsed = JSON.parse(jsonString) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as DockerConfigJsonData).auths !== "object" ||
    (parsed as DockerConfigJsonData).auths === null
  ) {
    return { auths: {} };
  }
  return { auths: (parsed as DockerConfigJsonData).auths };
}

/**
 * Extract `{registry, username}` for display from a dockerconfigjson Secret.
 * Returns `null` when the Secret is the wrong type, carries no decodable
 * payload, or has no auth entries. NEVER returns the password.
 *
 * The registry is reported as the first auth key; the canonical Docker Hub key
 * is surfaced as the friendly `docker.io` for the list view. The username is
 * read from the entry's `username` field, falling back to the user half of a
 * decoded `auth` (`user:pass`) when `username` is absent.
 */
export function extractRegistryFromSecret(
  secret: Secret,
): { registry: string; username: string } | null {
  if (secret.type !== DOCKERCONFIGJSON_TYPE) return null;
  const encoded = secret.data?.[DOCKERCONFIGJSON_KEY];
  if (encoded == null) return null;
  const json = base64Decode(encoded);
  if (json == null) return null;

  let parsed: DockerConfigJsonData;
  try {
    parsed = parseDockerConfigJson(json);
  } catch {
    return null;
  }

  const keys = Object.keys(parsed.auths);
  if (keys.length === 0) return null;
  const key = keys[0]!;
  const entry = parsed.auths[key]!;

  let username = entry.username ?? "";
  if (username === "" && typeof entry.auth === "string" && entry.auth !== "") {
    const decoded = base64Decode(entry.auth);
    if (decoded != null) {
      const idx = decoded.indexOf(":");
      if (idx >= 0) username = decoded.slice(0, idx);
    }
  }

  return { registry: displayRegistry(key), username };
}

/** Map a dockerconfigjson auth key back to a friendly hostname for display. */
export function displayRegistry(key: string): string {
  if (key === DOCKER_HUB_KEY) return "docker.io";
  return key;
}

// ---------------------------------------------------------------------------
// Validation (DNS-1123 subdomain for the Secret name) — pure, reused by the UI.
// ---------------------------------------------------------------------------

const DNS_1123_SUBDOMAIN =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** True when `name` is a valid DNS-1123 subdomain (≤253 chars). */
export function isValidDNS1123Subdomain(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  return DNS_1123_SUBDOMAIN.test(name);
}
