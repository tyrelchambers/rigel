// AI copilot credentials. The `claude` CLI authenticates via the
// CLAUDE_CODE_OAUTH_TOKEN env var (from `claude setup-token`). To let a
// self-hosting user configure it in-app (no YAML edit / restart), we ALSO accept
// a token saved in the cluster's rigel-user-config Secret and inject it at spawn
// time.
//
// Precedence: an explicit env var ALWAYS wins (set by Helm/compose); otherwise
// the token saved from the Settings screen against the active cluster is used.
import { CLAUDE_TOKEN_KEY } from "@rigel/k8s/src/userConfig";
import {
  readUserConfig,
  writeUserConfig,
  type ClusterConfigStatus,
} from "./clusterConfigStore";

function envToken(): string | null {
  const t = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  return t ? t : null;
}

/** The token to launch `claude` with — env wins, else the cluster's Secret. */
export async function effectiveClaudeToken(context: string | null): Promise<string | null> {
  const env = envToken();
  if (env) return env;
  const stored = (await readUserConfig(context)).data[CLAUDE_TOKEN_KEY].trim();
  return stored || null;
}

/** Persist a token to the cluster's Secret. Empty string clears it. Throws when
 *  there is no cluster to save to. */
export async function setClaudeToken(context: string | null, token: string): Promise<void> {
  await writeUserConfig(context, () => ({ [CLAUDE_TOKEN_KEY]: token.trim() }));
}

// When the token env var is fed by a k8s Secret (Helm sets these), point the UI
// straight at it so the user can edit it in the Secrets panel instead of hunting.
const SECRET_NAME = process.env.HELMSMAN_CLAUDE_SECRET?.trim() || null;
const SECRET_NS = process.env.POD_NAMESPACE?.trim() || null;

export interface ChatConfigStatus {
  configured: boolean;
  /** "env" = deployment-managed (read-only here); "cluster" = saved in-app. */
  source: "env" | "cluster" | null;
  /** The Secret backing the token env var, when known — for a deep link. */
  secret: { name: string; namespace: string } | null;
  /** Where an in-app save would go, and whether that cluster is reachable. */
  cluster: ClusterConfigStatus;
}

/** Chat-config status for the Settings screen / onboarding. */
export async function chatConfig(context: string | null): Promise<ChatConfigStatus> {
  const envSecret = SECRET_NAME ? { name: SECRET_NAME, namespace: SECRET_NS ?? "default" } : null;
  const read = await readUserConfig(context);
  const { data, ...cluster } = read;
  if (envToken()) return { configured: true, source: "env", secret: envSecret, cluster };
  if (data[CLAUDE_TOKEN_KEY].trim()) {
    return { configured: true, source: "cluster", secret: null, cluster };
  }
  return { configured: false, source: null, secret: null, cluster };
}
