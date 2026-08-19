// One-time lift of the pre-cluster local config files into the per-cluster
// Secret. Everything here exists only to drain those files; nothing reads them
// as a fallback, and once a machine has been migrated this module is inert.
//
// Values written to a local file went through encryptSecret, which marks a real
// keychain encryption with "enc:v1:". That marker is machine-specific, so a
// marked value is decrypted here before it is pushed to the cluster. When the
// keychain cannot decrypt it, decryptSecret yields "" — that field is left
// behind and the file is KEPT, because an unrecoverable value must not be
// silently replaced with an empty one.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import {
  AGENTS_CONFIG_KEY,
  CLAUDE_TOKEN_KEY,
  VOICE_CONFIG_KEY,
  type UserConfigData,
} from "@rigel/k8s/src/userConfig";
import { decryptSecret } from "./secretStore";

/** Voice secrets, mirroring the SECRET_FIELDS the old file encrypted. */
const VOICE_SECRET_FIELDS = new Set(["apiSecret", "openrouterApiKey"]);

export interface LocalConfigSnapshot {
  /** Values to push, keyed by Secret key. Only non-empty entries appear. */
  data: Partial<UserConfigData>;
  /** Files that may be removed once the push lands. */
  files: string[];
  /** Human-readable fields whose stored value could not be decrypted here. */
  undecryptable: string[];
}

function voiceFiles(): string[] {
  const dir = process.env.RIGEL_USER_DATA_DIR;
  const primary = dir ? join(dir, "rigel-voice.json") : join(homedir(), ".rigel", "rigel-voice.json");
  const legacy = join(homedir(), ".claude", "rigel-voice.json");
  return primary === legacy ? [primary] : [primary, legacy];
}

async function readJSONFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Decrypt a stored value, recording the field when the value is unrecoverable. */
function reveal(stored: string, field: string, undecryptable: string[]): string {
  const plain = decryptSecret(stored);
  if (!plain && stored) undecryptable.push(field);
  return plain;
}

function collectVoice(raw: Record<string, unknown>, undecryptable: string[]): string {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || !v) continue;
    out[k] = VOICE_SECRET_FIELDS.has(k) ? reveal(v, `voice.${k}`, undecryptable) : v;
    if (!out[k]) delete out[k];
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
}

function collectAgents(raw: Record<string, unknown>, undecryptable: string[]): string {
  const agents = raw.agents;
  const out: Record<string, unknown> = {};
  if (typeof raw.activeAgentId === "string") out.activeAgentId = raw.activeAgentId;
  if (agents && typeof agents === "object") {
    const next: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(agents as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const e = { ...(entry as Record<string, unknown>) };
      if (typeof e.apiKey === "string" && e.apiKey) {
        const plain = reveal(e.apiKey, `agents.${id}.apiKey`, undecryptable);
        if (plain) e.apiKey = plain;
        else delete e.apiKey;
      }
      next[id] = e;
    }
    if (Object.keys(next).length > 0) out.agents = next;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
}

/**
 * Everything the local files still hold, or null when there is nothing to move.
 * Reading never throws: an absent or unreadable file is simply nothing to lift.
 */
export async function readLocalConfig(): Promise<LocalConfigSnapshot | null> {
  const data: Partial<UserConfigData> = {};
  const files: string[] = [];
  const undecryptable: string[] = [];

  for (const path of voiceFiles()) {
    const raw = await readJSONFile(path);
    if (!raw) continue;
    files.push(path);
    if (data[VOICE_CONFIG_KEY]) continue;
    const voice = collectVoice(raw, undecryptable);
    if (voice) data[VOICE_CONFIG_KEY] = voice;
  }

  const agentsPath = join(homedir(), ".claude", "rigel-agents.json");
  const agentsRaw = await readJSONFile(agentsPath);
  if (agentsRaw) {
    files.push(agentsPath);
    const agents = collectAgents(agentsRaw, undecryptable);
    if (agents) data[AGENTS_CONFIG_KEY] = agents;
  }

  const tokenPath = join(homedir(), ".claude", "rigel-oauth-token");
  try {
    const stored = (await readFile(tokenPath, "utf8")).trim();
    files.push(tokenPath);
    if (stored) {
      const token = reveal(stored, "claudeToken", undecryptable);
      if (token) data[CLAUDE_TOKEN_KEY] = token;
    }
  } catch {
    /* absent or unreadable: nothing to lift */
  }

  if (files.length === 0) return null;
  return { data, files, undecryptable };
}

/** Remove the drained files. A failure to unlink is reported, never thrown. */
export async function removeLocalConfig(files: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const path of files) {
    try {
      await unlink(path);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== "ENOENT") failed.push(path);
    }
  }
  return failed;
}
