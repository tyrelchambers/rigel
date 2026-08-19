// Voice-assistant credentials (LiveKit + provider keys), stored per cluster in
// the rigel-user-config Secret. An explicit env var ALWAYS wins, per field:
// Helm and compose deployments set LIVEKIT_API_KEY and friends directly, and a
// value the deployment supplies must never be overridden by a saved one.
import {
  readUserConfig,
  writeUserConfig,
  type ClusterConfigStatus,
} from "./clusterConfigStore";
import { VOICE_CONFIG_KEY } from "@rigel/k8s/src/userConfig";

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

function storedVoice(blob: string): Partial<VoiceConfig> {
  const out: Partial<VoiceConfig> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob || "{}");
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const rec = parsed as Record<string, unknown>;
  for (const k of FIELDS) {
    const v = rec[k];
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

export interface VoiceConfigRead {
  config: VoiceConfig;
  cluster: ClusterConfigStatus;
}

/** Effective voice config: per-field env wins, else the cluster's Secret. */
export async function voiceConfig(context: string | null): Promise<VoiceConfigRead> {
  const read = await readUserConfig(context);
  const stored = storedVoice(read.data[VOICE_CONFIG_KEY]);
  const pick = (k: keyof VoiceConfig) => process.env[ENV_KEYS[k]]?.trim() || stored[k] || "";
  const { data: _data, ...cluster } = read;
  return {
    cluster,
    config: {
      url: pick("url"),
      apiKey: pick("apiKey"),
      apiSecret: pick("apiSecret"),
      openrouterApiKey: pick("openrouterApiKey"),
      model: pick("model") || DEFAULT_VOICE_MODEL,
      sttModel: pick("sttModel") || DEFAULT_STT_MODEL,
      ttsModel: pick("ttsModel") || DEFAULT_TTS_MODEL,
    },
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
export async function voiceStatus(context: string | null): Promise<VoiceStatus> {
  const { config: c } = await voiceConfig(context);
  return {
    enabled: voiceEnabled(),
    configured: !!(c.url && c.apiKey && c.apiSecret && c.openrouterApiKey),
  };
}

/** Merge a Settings patch into the cluster's config. An empty-string field
 * clears the stored value; undefined leaves it alone. Throws when there is no
 * cluster to save to. */
export async function setVoiceConfig(
  context: string | null,
  patch: Partial<VoiceConfig>,
): Promise<void> {
  await writeUserConfig(context, (current) => {
    const stored = storedVoice(current[VOICE_CONFIG_KEY]) as Record<string, string>;
    for (const k of FIELDS) {
      const v = patch[k];
      if (v === undefined) continue;
      const t = v.trim();
      if (!t) delete stored[k];
      else stored[k] = t;
    }
    return { [VOICE_CONFIG_KEY]: JSON.stringify(stored) };
  });
}
