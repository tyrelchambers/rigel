import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_CONFIG_KEY } from "@rigel/k8s/src/userConfig";
import {
  __setClusterConfigIO,
  __useFakeClusterConfig,
  __resetClusterConfigCache,
  type FakeClusterConfig,
} from "./clusterConfigStore";
import {
  voiceConfig, voiceStatus, setVoiceConfig, envVoiceFields,
  DEFAULT_VOICE_MODEL, DEFAULT_STT_MODEL, DEFAULT_TTS_MODEL, VOICE_FIELDS, VOICE_SECRET_FIELDS,
} from "./voiceConfig";

const ENV_KEYS = [
  "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "OPENROUTER_API_KEY",
  "RIGEL_VOICE_MODEL", "RIGEL_VOICE_STT_MODEL", "RIGEL_VOICE_TTS_MODEL", "RIGEL_VOICE",
  "RIGEL_USER_DATA_DIR",
];

/** Config is per cluster, so every call names the context it belongs to. */
const CTX = "test-cluster";

let fake: FakeClusterConfig;
let prevHome: string | undefined;
let prevEnv: Record<string, string | undefined>;

beforeEach(async () => {
  fake = __useFakeClusterConfig();
  prevHome = process.env.HOME;
  prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // No local fallback exists any more, but a stray file under the developer's
  // real HOME would still be picked up by the one-time migration, so point HOME
  // somewhere empty.
  process.env.HOME = await mkdtemp(join(tmpdir(), "rigel-voice-test-"));
});

afterEach(() => {
  __setClusterConfigIO(null);
  __resetClusterConfigCache();
  process.env.HOME = prevHome;
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("voiceConfig", () => {
  test("empty when nothing is set, with the default models", async () => {
    const { config: c, cluster } = await voiceConfig(CTX);
    expect(c.url).toBe("");
    expect(c.apiSecret).toBe("");
    expect(c.model).toBe(DEFAULT_VOICE_MODEL);
    expect(c.sttModel).toBe(DEFAULT_STT_MODEL);
    expect(c.ttsModel).toBe(DEFAULT_TTS_MODEL);
    expect(cluster.state).toBe("ok");
  });

  test("env wins over the stored value, per field", async () => {
    await setVoiceConfig(CTX, { url: "wss://stored.example", apiKey: "stored-key" });
    process.env.LIVEKIT_URL = "wss://env.example";
    const { config: c } = await voiceConfig(CTX);
    expect(c.url).toBe("wss://env.example");
    expect(c.apiKey).toBe("stored-key");
  });

  test("sttModel/ttsModel follow the env-then-cluster-then-default pattern", async () => {
    await setVoiceConfig(CTX, { sttModel: "deepgram/nova-2" });
    process.env.RIGEL_VOICE_TTS_MODEL = "cartesia/sonic-turbo";
    const { config: c } = await voiceConfig(CTX);
    expect(c.sttModel).toBe("deepgram/nova-2");
    expect(c.ttsModel).toBe("cartesia/sonic-turbo");
  });

  test("set + read round-trips through the cluster's Secret", async () => {
    await setVoiceConfig(CTX, { apiSecret: "s3cret", openrouterApiKey: "or-key", url: "wss://x" });
    const { config: c } = await voiceConfig(CTX);
    expect(c.apiSecret).toBe("s3cret");
    expect(c.openrouterApiKey).toBe("or-key");
    expect(JSON.parse(fake.secrets.get(CTX)![VOICE_CONFIG_KEY])).toMatchObject({ url: "wss://x" });
  });

  test("an empty-string patch field clears the stored value", async () => {
    await setVoiceConfig(CTX, { url: "wss://x" });
    await setVoiceConfig(CTX, { url: "" });
    expect((await voiceConfig(CTX)).config.url).toBe("");
  });

  test("config follows the cluster: another context sees none of it", async () => {
    await setVoiceConfig(CTX, { url: "wss://one" });
    expect((await voiceConfig("other-cluster")).config.url).toBe("");
  });

  test("an unreachable cluster reports unavailable, not an empty config", async () => {
    fake.reachable = false;
    const { config: c, cluster } = await voiceConfig(CTX);
    expect(cluster.state).toBe("unavailable");
    expect(cluster.context).toBe(CTX);
    expect(cluster.message).toMatch(/connection to the server/);
    expect(c.url).toBe("");
  });

  test("an env-supplied field still resolves with no cluster", async () => {
    fake.reachable = false;
    process.env.LIVEKIT_URL = "wss://env.example";
    const { config: c } = await voiceConfig(CTX);
    expect(c.url).toBe("wss://env.example");
  });

  test("saving with no cluster throws rather than saving nowhere", async () => {
    fake.reachable = false;
    await expect(setVoiceConfig(CTX, { url: "wss://x" })).rejects.toThrow(/no cluster to save to/);
  });
});

describe("voiceStatus", () => {
  test("enabled tracks RIGEL_VOICE=1; configured needs url+key+secret+openrouter", async () => {
    expect(await voiceStatus(CTX)).toEqual({ enabled: false, configured: false });
    process.env.RIGEL_VOICE = "1";
    await setVoiceConfig(CTX, { url: "wss://x", apiKey: "k", apiSecret: "s", openrouterApiKey: "o" });
    expect(await voiceStatus(CTX)).toEqual({ enabled: true, configured: true });
  });
});

describe("envVoiceFields", () => {
  test("empty when no env var is set", async () => {
    await setVoiceConfig(CTX, { url: "wss://stored" });
    expect(envVoiceFields()).toEqual({});
  });

  test("maps only the env-supplied fields to their variable names", () => {
    process.env.LIVEKIT_URL = "wss://env";
    process.env.RIGEL_VOICE_STT_MODEL = "deepgram/nova-2";
    expect(envVoiceFields()).toEqual({ url: "LIVEKIT_URL", sttModel: "RIGEL_VOICE_STT_MODEL" });
  });

  test("a blank env var does not count as supplied", () => {
    process.env.LIVEKIT_URL = "   ";
    expect(envVoiceFields()).toEqual({});
  });
});

describe("field lists", () => {
  test("VOICE_FIELDS covers every config key and names the two secrets", () => {
    expect([...VOICE_FIELDS].sort()).toEqual(
      ["apiKey", "apiSecret", "model", "openrouterApiKey", "sttModel", "ttsModel", "url"],
    );
    expect([...VOICE_SECRET_FIELDS]).toEqual(["apiSecret", "openrouterApiKey"]);
  });
});
