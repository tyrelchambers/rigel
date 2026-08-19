// Voice-assistant credentials (LiveKit + provider keys). Unlike chatConfig.ts
// (a Claude credential, which belongs under ~/.claude), LiveKit/OpenRouter have
// nothing to do with Claude Code, so this lives in the app's own data dir. An
// explicit env var always wins; otherwise the file written from Settings is
// used, with secret fields encrypted at rest via secretStore.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { decryptSecret, encryptSecret } from "./secretStore";

export const DEFAULT_VOICE_MODEL = "openai/gpt-4.1-mini";
// LiveKit Inference model strings (provider/model). nova-3 is Deepgram's
// low-latency streaming STT; sonic-2 is Cartesia's balanced low-latency TTS.
// Both run through the same LiveKit API key/secret as the turn detector.
export const DEFAULT_STT_MODEL = "deepgram/nova-3";
export const DEFAULT_TTS_MODEL = "cartesia/sonic-2";

export interface VoiceConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  openrouterApiKey: string;
  model: string;
  sttModel: string;
  ttsModel: string;
}

const ENV_KEYS: Record<keyof VoiceConfig, string> = {
  url: "LIVEKIT_URL",
  apiKey: "LIVEKIT_API_KEY",
  apiSecret: "LIVEKIT_API_SECRET",
  openrouterApiKey: "OPENROUTER_API_KEY",
  model: "RIGEL_VOICE_MODEL",
  sttModel: "RIGEL_VOICE_STT_MODEL",
  ttsModel: "RIGEL_VOICE_TTS_MODEL",
};

const SECRET_FIELDS = new Set<keyof VoiceConfig>(["apiSecret", "openrouterApiKey"]);

const FIELDS = Object.keys(ENV_KEYS) as (keyof VoiceConfig)[];

/** Every configurable field, in the order the Settings panel presents them. */
export const VOICE_FIELDS: readonly (keyof VoiceConfig)[] = FIELDS;

export const VOICE_SECRET_FIELDS: readonly (keyof VoiceConfig)[] = FIELDS.filter((k) =>
  SECRET_FIELDS.has(k),
);

/**
 * Fields an env var is currently supplying, mapped to the var's name. Env wins
 * per field in voiceConfig(), so Settings must show these as not editable
 * rather than accept an edit it would silently ignore.
 */
export function envVoiceFields(): Partial<Record<keyof VoiceConfig, string>> {
  const out: Partial<Record<keyof VoiceConfig, string>> = {};
  for (const k of FIELDS) {
    if (process.env[ENV_KEYS[k]]?.trim()) out[k] = ENV_KEYS[k];
  }
  return out;
}

// A function, not a module-level constant: main.ts sets RIGEL_USER_DATA_DIR
// once per launch, but tests (and dev's plain-Node fallback) override HOME
// per test, so the path must be re-resolved on every call rather than fixed
// at import time.
function configFile(): string {
  const dir = process.env.RIGEL_USER_DATA_DIR;
  if (dir) return join(dir, "rigel-voice.json");
  // No Electron parent forked us (plain `tsx watch`, tests): fall back to a
  // dedicated dot-dir rather than squatting in ~/.claude again.
  return join(homedir(), ".rigel", "rigel-voice.json");
}

function legacyConfigFile(): string {
  return join(homedir(), ".claude", "rigel-voice.json");
}

/** One-time move of a pre-migration config file into the new location. No-op
 * once the new file exists; a legacy file that is absent or unreadable is
 * treated as nothing to migrate rather than an error. */
async function migrateLegacyConfig(target: string): Promise<void> {
  const legacy = legacyConfigFile();
  if (target === legacy) return;
  try {
    await access(target);
    return;
  } catch {
    /* target absent; fall through to check for a legacy file */
  }
  let raw: string;
  try {
    raw = await readFile(legacy, "utf8");
  } catch {
    return;
  }
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, raw, { mode: 0o600 });
    await unlink(legacy);
    console.log(`[rigel] migrated voice config from ${legacy} to ${target}`);
  } catch (err) {
    console.error(`[rigel] failed to migrate voice config from ${legacy}:`, err);
  }
}

async function fileConfig(): Promise<Partial<VoiceConfig>> {
  const file = configFile();
  await migrateLegacyConfig(file);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<VoiceConfig>;
    const out: Partial<VoiceConfig> = {};
    for (const k of FIELDS) {
      const v = parsed[k];
      if (typeof v !== "string" || !v) continue;
      out[k] = SECRET_FIELDS.has(k) ? decryptSecret(v) : v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Effective voice config: per-field env wins, else the Settings file. */
export async function voiceConfig(): Promise<VoiceConfig> {
  const file = await fileConfig();
  const pick = (k: keyof VoiceConfig) => process.env[ENV_KEYS[k]]?.trim() || file[k] || "";
  return {
    url: pick("url"),
    apiKey: pick("apiKey"),
    apiSecret: pick("apiSecret"),
    openrouterApiKey: pick("openrouterApiKey"),
    model: pick("model") || DEFAULT_VOICE_MODEL,
    sttModel: pick("sttModel") || DEFAULT_STT_MODEL,
    ttsModel: pick("ttsModel") || DEFAULT_TTS_MODEL,
  };
}

export function voiceEnabled(): boolean {
  return process.env.RIGEL_VOICE === "1";
}

export interface VoiceStatus {
  enabled: boolean;
  configured: boolean;
}

/** configured = the room can be minted AND the LLM can run. STT/TTS ride on
 * the same LiveKit apiKey/apiSecret already checked here. */
export async function voiceStatus(): Promise<VoiceStatus> {
  const c = await voiceConfig();
  return {
    enabled: voiceEnabled(),
    configured: !!(c.url && c.apiKey && c.apiSecret && c.openrouterApiKey),
  };
}

/** Merge a Settings patch into the file (secrets encrypted, mode 0600). An
 * empty-string field clears the stored value; undefined leaves it alone. */
export async function setVoiceConfig(patch: Partial<VoiceConfig>): Promise<void> {
  const file = configFile();
  await migrateLegacyConfig(file);
  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
  } catch {
    /* absent */
  }
  for (const k of FIELDS) {
    const v = patch[k];
    if (v === undefined) continue;
    const t = v.trim();
    if (!t) delete existing[k];
    else existing[k] = SECRET_FIELDS.has(k) ? encryptSecret(t) : t;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(existing, null, 2), { mode: 0o600 });
}
