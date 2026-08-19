import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  voiceConfig, voiceStatus, setVoiceConfig, envVoiceFields,
  DEFAULT_VOICE_MODEL, DEFAULT_STT_MODEL, DEFAULT_TTS_MODEL, VOICE_FIELDS, VOICE_SECRET_FIELDS,
} from "./voiceConfig";

const ENV_KEYS = [
  "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "OPENROUTER_API_KEY",
  "RIGEL_VOICE_MODEL", "RIGEL_VOICE_STT_MODEL", "RIGEL_VOICE_TTS_MODEL", "RIGEL_VOICE",
  "RIGEL_USER_DATA_DIR",
];

let prevHome: string | undefined;
let prevEnv: Record<string, string | undefined>;

beforeEach(async () => {
  prevHome = process.env.HOME;
  prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  const home = await mkdtemp(join(tmpdir(), "rigel-voice-test-"));
  process.env.HOME = home;
  await mkdir(join(home, ".rigel"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = prevHome;
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("voiceConfig", () => {
  test("empty when nothing is set, with the default models", async () => {
    const c = await voiceConfig();
    expect(c.url).toBe("");
    expect(c.apiSecret).toBe("");
    expect(c.model).toBe(DEFAULT_VOICE_MODEL);
    expect(c.sttModel).toBe(DEFAULT_STT_MODEL);
    expect(c.ttsModel).toBe(DEFAULT_TTS_MODEL);
  });

  test("env wins over the file, per field", async () => {
    await setVoiceConfig({ url: "wss://file.example", apiKey: "file-key" });
    process.env.LIVEKIT_URL = "wss://env.example";
    const c = await voiceConfig();
    expect(c.url).toBe("wss://env.example");
    expect(c.apiKey).toBe("file-key");
  });

  test("sttModel/ttsModel follow the env-then-file-then-default pattern", async () => {
    await setVoiceConfig({ sttModel: "deepgram/nova-2" });
    process.env.RIGEL_VOICE_TTS_MODEL = "cartesia/sonic-turbo";
    const c = await voiceConfig();
    expect(c.sttModel).toBe("deepgram/nova-2");
    expect(c.ttsModel).toBe("cartesia/sonic-turbo");
  });

  test("set + read round-trips through the public API", async () => {
    await setVoiceConfig({ apiSecret: "s3cret", openrouterApiKey: "or-key", url: "wss://x" });
    const c = await voiceConfig();
    expect(c.apiSecret).toBe("s3cret");
    expect(c.openrouterApiKey).toBe("or-key");
    const raw = await readFile(join(process.env.HOME!, ".rigel", "rigel-voice.json"), "utf8");
    expect(raw).toContain("wss://x");
  });

  test("uses RIGEL_USER_DATA_DIR when set, instead of the dev fallback", async () => {
    const userData = await mkdtemp(join(tmpdir(), "rigel-voice-userdata-"));
    process.env.RIGEL_USER_DATA_DIR = userData;
    await setVoiceConfig({ url: "wss://userdata" });
    const raw = await readFile(join(userData, "rigel-voice.json"), "utf8");
    expect(raw).toContain("wss://userdata");
  });

  test("saves when the fallback dot-dir does not exist yet", async () => {
    process.env.HOME = await mkdtemp(join(tmpdir(), "rigel-voice-nohome-"));
    await setVoiceConfig({ url: "wss://fresh" });
    expect((await voiceConfig()).url).toBe("wss://fresh");
  });

  test("saves into a nested RIGEL_USER_DATA_DIR subpath that does not exist yet", async () => {
    const base = await mkdtemp(join(tmpdir(), "rigel-voice-nested-"));
    process.env.RIGEL_USER_DATA_DIR = join(base, "Rigel");
    await setVoiceConfig({ url: "wss://nested" });
    expect((await voiceConfig()).url).toBe("wss://nested");
  });

  test("an empty-string patch field clears the stored value", async () => {
    await setVoiceConfig({ url: "wss://x" });
    await setVoiceConfig({ url: "" });
    expect((await voiceConfig()).url).toBe("");
  });
});

describe("legacy config migration", () => {
  async function writeLegacy(home: string, contents: object): Promise<string> {
    const dir = join(home, ".claude");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "rigel-voice.json");
    await writeFile(file, JSON.stringify(contents), { mode: 0o600 });
    return file;
  }

  test("old file present, new absent: migrates on first read and removes the old file", async () => {
    const home = process.env.HOME!;
    const legacy = await writeLegacy(home, { url: "wss://legacy", apiKey: "legacy-key" });

    const c = await voiceConfig();
    expect(c.url).toBe("wss://legacy");
    expect(c.apiKey).toBe("legacy-key");

    await expect(readFile(legacy, "utf8")).rejects.toThrow();
    const migrated = await readFile(join(home, ".rigel", "rigel-voice.json"), "utf8");
    expect(migrated).toContain("wss://legacy");
  });

  test("both present: the new file wins and the old file is left untouched", async () => {
    const home = process.env.HOME!;
    const legacy = await writeLegacy(home, { url: "wss://legacy" });
    const newDir = join(home, ".rigel");
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, "rigel-voice.json"), JSON.stringify({ url: "wss://current" }), {
      mode: 0o600,
    });

    const c = await voiceConfig();
    expect(c.url).toBe("wss://current");
    const legacyRaw = await readFile(legacy, "utf8");
    expect(legacyRaw).toContain("wss://legacy");
  });

  test("neither present: reads as empty, no throw", async () => {
    const c = await voiceConfig();
    expect(c.url).toBe("");
  });

  test("old file present but unreadable: treated as nothing to migrate, no throw", async () => {
    const home = process.env.HOME!;
    const legacy = await writeLegacy(home, { url: "wss://legacy" });
    await chmod(legacy, 0o000);

    try {
      const c = await voiceConfig();
      expect(c.url).toBe("");
      await expect(readFile(join(home, ".rigel", "rigel-voice.json"), "utf8")).rejects.toThrow();
    } finally {
      await chmod(legacy, 0o600);
    }
  });
});

describe("voiceStatus", () => {
  test("enabled tracks RIGEL_VOICE=1; configured needs url+key+secret+openrouter", async () => {
    expect(await voiceStatus()).toEqual({ enabled: false, configured: false });
    process.env.RIGEL_VOICE = "1";
    await setVoiceConfig({ url: "wss://x", apiKey: "k", apiSecret: "s", openrouterApiKey: "o" });
    expect(await voiceStatus()).toEqual({ enabled: true, configured: true });
  });
});

describe("envVoiceFields", () => {
  test("empty when no env var is set", async () => {
    await setVoiceConfig({ url: "wss://file" });
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
