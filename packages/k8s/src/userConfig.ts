// The per-cluster Secret holding the configuration a Rigel user enters: voice
// credentials, per-agent auth, and the Claude subscription token. Shape, parse,
// and manifest builders only; the kubectl I/O lives in
// apps/server/src/clusterConfigStore.ts (same split as gitSources.ts + git.ts).
//
// Values are stored in PLAINTEXT inside the Secret. A Secret is base64, not
// encrypted at rest by default, so this is no more secret than the local files
// it replaces; it is machine-independent, which the safeStorage-encrypted local
// values were not.

/** One Secret, not three: the three stores share a lifecycle (this user's config
 *  for this cluster), one read serves all of them, and a single object makes the
 *  serialized read-modify-write trivially correct. */
export const USER_CONFIG_SECRET = "rigel-user-config";

export const VOICE_CONFIG_KEY = "voice.json";
export const AGENTS_CONFIG_KEY = "agents.json";
export const CLAUDE_TOKEN_KEY = "claude-oauth-token";
export const FAILOVER_CONFIG_KEY = "failover.json";

export type UserConfigKey =
  | typeof VOICE_CONFIG_KEY
  | typeof AGENTS_CONFIG_KEY
  | typeof CLAUDE_TOKEN_KEY
  | typeof FAILOVER_CONFIG_KEY;

export const USER_CONFIG_KEYS: readonly UserConfigKey[] = [
  VOICE_CONFIG_KEY,
  AGENTS_CONFIG_KEY,
  CLAUDE_TOKEN_KEY,
  FAILOVER_CONFIG_KEY,
];

export type UserConfigData = Record<UserConfigKey, string>;

const MANAGED_BY = { "app.kubernetes.io/managed-by": "rigel" };

/** A config with every key present and empty: connected, nothing configured. */
export function emptyUserConfigData(): UserConfigData {
  return {
    [VOICE_CONFIG_KEY]: "",
    [AGENTS_CONFIG_KEY]: "",
    [CLAUDE_TOKEN_KEY]: "",
    [FAILOVER_CONFIG_KEY]: "",
  };
}

/** True when every key is blank, i.e. nothing has ever been saved. */
export function isUserConfigEmpty(data: UserConfigData): boolean {
  return USER_CONFIG_KEYS.every((k) => !data[k].trim());
}

/**
 * Decode a `kubectl get secret -o json` payload into the three known entries.
 * Unknown keys are dropped and a malformed payload reads as empty, so a
 * hand-edited Secret can neither smuggle fields in nor throw on a config read.
 *
 * `decodeBase64` is a parameter because this package is compiled for the
 * browser too, where node's Buffer does not exist.
 */
export function parseUserConfigSecret(
  stdout: string,
  decodeBase64: (value: string) => string,
): UserConfigData {
  const out = emptyUserConfigData();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return out;
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") return out;
  for (const key of USER_CONFIG_KEYS) {
    const raw = (data as Record<string, unknown>)[key];
    if (typeof raw !== "string" || !raw) continue;
    try {
      out[key] = decodeBase64(raw);
    } catch {
      out[key] = "";
    }
  }
  return out;
}

/**
 * The full Secret manifest. Every key is always written (blank when unset) so an
 * apply never has to delete a key, which keeps the result independent of
 * whatever last-applied-configuration the object carries.
 */
export function userConfigSecretJSON(namespace: string, data: UserConfigData): string {
  const stringData: Record<string, string> = {};
  for (const key of USER_CONFIG_KEYS) stringData[key] = data[key] ?? "";
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: USER_CONFIG_SECRET, namespace, labels: MANAGED_BY },
    type: "Opaque",
    stringData,
  });
}

/**
 * Whether a failed `kubectl get` means "the object is not there" as opposed to
 * "the cluster could not be reached". Only an apiserver NotFound counts: a
 * refused connection, a missing context, a Forbidden, or a missing kubectl must
 * all read as unavailable so the UI says "not connected" rather than showing an
 * empty config that looks like "not configured yet".
 */
export function isSecretAbsent(res: { code: number; stderr: string }): boolean {
  return res.code !== 0 && /\(NotFound\)/.test(res.stderr);
}
