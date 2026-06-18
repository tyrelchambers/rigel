// AI copilot credentials. The `claude` CLI authenticates via the
// CLAUDE_CODE_OAUTH_TOKEN env var (from `claude setup-token`). To let a
// self-hosting user configure it in-app (no YAML edit / restart), we ALSO accept
// a token persisted to the writable claude home and inject it at spawn time.
//
// Precedence: an explicit env var ALWAYS wins (set by Helm/compose); otherwise
// the file written from the Settings screen is used.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, unlink, writeFile } from "node:fs/promises";

const TOKEN_FILE = join(homedir(), ".claude", "helmsman-oauth-token");

function envToken(): string | null {
  const t = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  return t ? t : null;
}

async function fileToken(): Promise<string | null> {
  try {
    const t = (await readFile(TOKEN_FILE, "utf8")).trim();
    return t || null;
  } catch {
    // ENOENT (file absent) or any read error → treat as no token.
    return null;
  }
}

/** The token to launch `claude` with — env wins, else the persisted file. */
export async function effectiveClaudeToken(): Promise<string | null> {
  return envToken() ?? (await fileToken());
}

/** Persist a token to the claude home (chmod 600). Empty string clears it. */
export async function setClaudeToken(token: string): Promise<void> {
  const t = token.trim();
  if (!t) {
    await clearClaudeToken();
    return;
  }
  // mode 0o600 replaces the prior chmod-spawn: owner read/write only.
  await writeFile(TOKEN_FILE, t, { mode: 0o600 });
}

export async function clearClaudeToken(): Promise<void> {
  try {
    await unlink(TOKEN_FILE);
  } catch {
    /* already absent */
  }
}

// When the token env var is fed by a k8s Secret (Helm sets these), point the UI
// straight at it so the user can edit it in the Secrets panel instead of hunting.
const SECRET_NAME = process.env.HELMSMAN_CLAUDE_SECRET?.trim() || null;
const SECRET_NS = process.env.POD_NAMESPACE?.trim() || null;

export interface ChatConfigStatus {
  configured: boolean;
  /** "env" = deployment-managed (read-only here); "file" = set in-app (editable). */
  source: "env" | "file" | null;
  /** The Secret backing the token env var, when known — for a deep link. */
  secret: { name: string; namespace: string } | null;
}

/** Chat-config status for the Settings screen / onboarding. */
export async function chatConfig(): Promise<ChatConfigStatus> {
  const secret = SECRET_NAME ? { name: SECRET_NAME, namespace: SECRET_NS ?? "default" } : null;
  if (envToken()) return { configured: true, source: "env", secret };
  if (await fileToken()) return { configured: true, source: "file", secret: null };
  return { configured: false, source: null, secret: null };
}
