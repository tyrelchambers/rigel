// Lift of the pre-cluster local config files into the per-cluster Secret. Runs
// on every read, not just when the Secret is absent: a Secret that already
// holds SOME keys is not "migrated", it is exactly the half-migrated state this
// module has to keep making progress on.
//
// Per key, "already migrated" means "the Secret currently holds a non-empty
// value for it", regardless of whether that value came from this module or
// from a Settings save. That value always wins over the local file, which
// prevents a stale local copy from resurrecting a value the user deliberately
// cleared: the moment a source is read, its file is dropped (see drain()
// below), whether it was just lifted or was already present in the Secret.
// This relies on nothing else ever writing to these legacy files once a
// cluster is connected (true today, see userConfig.ts), so it cannot notice a
// value resurrected by some other writer; that is judged an acceptable gap,
// not a case this module defends against.
//
// Values written to a local file went through encryptSecret, which marks a
// real keychain encryption with "enc:v1:". That marker is machine-specific,
// so a marked value is decrypted here before it is pushed to the cluster.
// When the keychain cannot decrypt it, decryptSecret yields "", so that file
// is left behind and is never dropped, because an unrecoverable value must not
// be silently replaced with an empty one.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import {
  AGENTS_CONFIG_KEY,
  CLAUDE_TOKEN_KEY,
  type UserConfigData,
  type UserConfigKey,
} from "@rigel/k8s/src/userConfig";
import { decryptSecret } from "./secretStore";

export interface LocalConfigLift {
  /** Full replacement value per Secret key that changed. Spread this over the
   *  current data; a key not present here means "leave it alone". */
  data: Partial<UserConfigData>;
  /** Local files this pass looked at, for the summary log line. */
  files: string[];
  /** Human-readable fields whose stored value could not be decrypted here. */
  undecryptable: string[];
  /** Removes/rewrites the local files to drop whatever just landed. Call only
   *  after `data` has been written successfully, or immediately when `data`
   *  is empty (there was nothing that needed writing). */
  drain(): Promise<void>;
}

/** Decrypt a stored value, recording the field when the value is unrecoverable. */
function reveal(stored: string, field: string, undecryptable: string[]): string {
  const plain = decryptSecret(stored);
  if (!plain && stored) undecryptable.push(field);
  return plain;
}

/** Never throws: a drain that cannot remove its own leftovers must not take
 *  the read path down with it. Retried next time this source is read. */
async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* left behind; picked up again on the next read */
  }
}

interface SourceLift {
  /** The full replacement value for this Secret key, when it changed. */
  value?: string;
  undecryptable: string[];
  touched: string[];
  drain(): Promise<void>;
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
 * A whole-blob local source (agents.json, the oauth token): lifted only while
 * the Secret's key is still empty, since these have no per-field breakdown to
 * merge against. Once the Secret has anything for this key, the local file is
 * redundant and is dropped without being read into the result, so a value the
 * user cleared is never resurrected. A value this module cannot decrypt is
 * always kept, key state aside.
 */
async function liftAtomic(
  path: string,
  current: string,
  extract: (raw: string) => { value: string; undecryptable: string[] },
): Promise<SourceLift | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const { value, undecryptable } = extract(raw);
  if (undecryptable.length > 0) {
    return { undecryptable, touched: [path], drain: async () => {} };
  }
  return {
    undecryptable: [],
    touched: [path],
    value: current.trim() || !value ? undefined : value,
    drain: () => unlinkQuiet(path),
  };
}

function extractAgents(raw: string): { value: string; undecryptable: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: "", undecryptable: [] };
  }
  if (!parsed || typeof parsed !== "object") return { value: "", undecryptable: [] };
  const undecryptable: string[] = [];
  const value = collectAgents(parsed as Record<string, unknown>, undecryptable);
  return { value, undecryptable };
}

function extractToken(raw: string): { value: string; undecryptable: string[] } {
  const stored = raw.trim();
  if (!stored) return { value: "", undecryptable: [] };
  const undecryptable: string[] = [];
  const token = reveal(stored, "claudeToken", undecryptable);
  return { value: token, undecryptable };
}

/**
 * Everything the local files still hold that the Secret does not, keyed
 * against `current` so an already-populated field is never overwritten and a
 * field the user cleared is never resurrected. Returns null when the local
 * files have nothing left to say, in which case there is nothing to write and
 * nothing to drain.
 */
export async function readLocalConfig(current: UserConfigData): Promise<LocalConfigLift | null> {
  const sources: Array<{ key: UserConfigKey; lift: SourceLift }> = [];

  const agents = await liftAtomic(
    join(homedir(), ".claude", "rigel-agents.json"),
    current[AGENTS_CONFIG_KEY],
    extractAgents,
  );
  if (agents) sources.push({ key: AGENTS_CONFIG_KEY, lift: agents });

  const token = await liftAtomic(join(homedir(), ".claude", "rigel-oauth-token"), current[CLAUDE_TOKEN_KEY], extractToken);
  if (token) sources.push({ key: CLAUDE_TOKEN_KEY, lift: token });

  if (sources.length === 0) return null;

  const data: Partial<UserConfigData> = {};
  const files: string[] = [];
  const undecryptable: string[] = [];
  for (const { key, lift } of sources) {
    if (lift.value !== undefined) data[key] = lift.value;
    files.push(...lift.touched);
    undecryptable.push(...lift.undecryptable);
  }

  return {
    data,
    files,
    undecryptable,
    drain: async () => {
      for (const { lift } of sources) await lift.drain();
    },
  };
}
