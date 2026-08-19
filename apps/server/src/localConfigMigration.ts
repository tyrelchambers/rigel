// Lift of the pre-cluster local config files into the per-cluster Secret, one
// field at a time. Runs on every read, not just when the Secret is absent: a
// Secret that already holds SOME fields is not "migrated", it is exactly the
// half-migrated state this module has to keep making progress on.
//
// Per field, "already migrated" means "the Secret currently holds a
// non-empty value for it", regardless of whether that value came from this
// module or from a Settings save. That value always wins over the local
// file, which prevents a stale local copy from resurrecting a value the user
// deliberately cleared: the moment a field is read from a local file, it is
// dropped from that file (see drain() below), whether it was just lifted or
// was already present in the Secret. So a field can only ever be considered
// "still pending" here while it has never once been read by this module,
// which is exactly the set the local file still holds. This relies on
// nothing else ever writing to these legacy files once a cluster is
// connected (true today, see userConfig.ts), so it cannot notice a value
// resurrected by some other writer; that is judged an acceptable gap, not a
// case this module defends against.
//
// Values written to a local file went through encryptSecret, which marks a
// real keychain encryption with "enc:v1:". That marker is machine-specific,
// so a marked value is decrypted here before it is pushed to the cluster.
// When the keychain cannot decrypt it, decryptSecret yields "", so that field
// is left behind in the file and is never dropped, because an unrecoverable
// value must not be silently replaced with an empty one.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, unlink, writeFile } from "node:fs/promises";
import {
  AGENTS_CONFIG_KEY,
  CLAUDE_TOKEN_KEY,
  VOICE_CONFIG_KEY,
  type UserConfigData,
  type UserConfigKey,
} from "@rigel/k8s/src/userConfig";
import { decryptSecret } from "./secretStore";

/** Voice secrets, mirroring the SECRET_FIELDS the old file encrypted. */
const VOICE_SECRET_FIELDS = new Set(["apiSecret", "openrouterApiKey"]);

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

function parseVoiceBlob(blob: string): Record<string, string> {
  if (!blob) return {};
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
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

/**
 * Every voice field the local file(s) still hold, decrypted where readable.
 * `currentVoice` is the Secret's current voice.json, parsed to field/value:
 * a field present there already wins and is never overwritten by the local
 * copy, which is then dropped (see the module comment for why that is safe).
 * Only the first file with any usable content is read; a second (legacy) path
 * is treated as a duplicate of the first and cleaned up alongside it.
 */
async function liftVoice(currentBlob: string): Promise<SourceLift | null> {
  const currentVoice = parseVoiceBlob(currentBlob);
  const undecryptable: string[] = [];
  const keep: Record<string, unknown> = {};
  const touched: string[] = [];
  const others: string[] = [];
  let winner: string | null = null;
  let value: string | undefined;

  for (const path of voiceFiles()) {
    const raw = await readJSONFile(path);
    if (!raw) continue;
    touched.push(path);
    if (winner) {
      others.push(path);
      continue;
    }
    winner = path;
    const missing: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== "string" || !v) continue;
      if (VOICE_SECRET_FIELDS.has(k)) {
        const plain = reveal(v, `voice.${k}`, undecryptable);
        if (plain) {
          if (!currentVoice[k]) missing[k] = plain;
        } else {
          keep[k] = v;
        }
      } else if (!currentVoice[k]) {
        missing[k] = v;
      }
    }
    if (Object.keys(missing).length > 0) value = JSON.stringify({ ...currentVoice, ...missing });
  }
  if (!winner) return null;

  return {
    value,
    undecryptable,
    touched,
    drain: async () => {
      if (Object.keys(keep).length > 0) {
        try {
          await writeFile(winner!, JSON.stringify(keep), { mode: 0o600 });
        } catch {
          /* left with the fields already lifted still in it; retried next read */
        }
      } else {
        await unlinkQuiet(winner!);
      }
      for (const other of others) await unlinkQuiet(other);
    },
  };
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
 * redundant and is dropped without being read into the result, for the same
 * "never resurrect" reason liftVoice drops fields it has already accounted
 * for. A value this module cannot decrypt is always kept, key state aside.
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

  const voice = await liftVoice(current[VOICE_CONFIG_KEY]);
  if (voice) sources.push({ key: VOICE_CONFIG_KEY, lift: voice });

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
