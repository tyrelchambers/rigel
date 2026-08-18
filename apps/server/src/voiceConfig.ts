// Voice-assistant credentials (LiveKit + provider keys). Same pattern as
// chatConfig.ts: an explicit env var always wins; otherwise the file written
// from Settings is used, with secret fields encrypted at rest via secretStore.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
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

function configFile(): string {
  return join(homedir(), ".claude", "rigel-voice.json");
}

async function fileConfig(): Promise<Partial<VoiceConfig>> {
  try {
    const parsed = JSON.parse(await readFile(configFile(), "utf8")) as Partial<VoiceConfig>;
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
  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(await readFile(configFile(), "utf8")) as Record<string, string>;
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
  await writeFile(configFile(), JSON.stringify(existing, null, 2), { mode: 0o600 });
}
