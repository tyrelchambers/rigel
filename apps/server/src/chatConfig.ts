// AI copilot credentials. The `claude` CLI authenticates via the
// CLAUDE_CODE_OAUTH_TOKEN env var (from `claude setup-token`). To let a
// self-hosting user configure it in-app (no YAML edit / restart), we ALSO accept
// a token persisted to the writable claude home and inject it at spawn time.
//
// Precedence: an explicit env var ALWAYS wins (set by Helm/compose); otherwise
// the file written from the Settings screen is used.
import { homedir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

const TOKEN_FILE = join(homedir(), ".claude", "helmsman-oauth-token");

function envToken(): string | null {
  const t = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  return t ? t : null;
}

async function fileToken(): Promise<string | null> {
  try {
    const f = Bun.file(TOKEN_FILE);
    if (!(await f.exists())) return null;
    const t = (await f.text()).trim();
    return t || null;
  } catch {
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
  await Bun.write(TOKEN_FILE, t);
  try {
    await Bun.spawn(["chmod", "600", TOKEN_FILE]).exited;
  } catch {
    /* best-effort hardening */
  }
}

export async function clearClaudeToken(): Promise<void> {
  try {
    await unlink(TOKEN_FILE);
  } catch {
    /* already absent */
  }
}

/**
 * Chat-config status for the UI. `source` tells the Settings screen whether the
 * token is env-managed (read-only here) or set in-app (file, editable).
 */
export async function chatConfig(): Promise<{ configured: boolean; source: "env" | "file" | null }> {
  if (envToken()) return { configured: true, source: "env" };
  if (await fileToken()) return { configured: true, source: "file" };
  return { configured: false, source: null };
}
