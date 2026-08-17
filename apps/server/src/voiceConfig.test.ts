import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { voiceConfig, voiceStatus, setVoiceConfig, DEFAULT_VOICE_MODEL } from "./voiceConfig";

const ENV_KEYS = [
  "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "OPENROUTER_API_KEY",
  "RIGEL_VOICE_MODEL", "DEEPGRAM_API_KEY", "CARTESIA_API_KEY", "RIGEL_VOICE",
];

let prevHome: string | undefined;
let prevEnv: Record<string, string | undefined>;

beforeEach(async () => {
  prevHome = process.env.HOME;
  prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  const home = await mkdtemp(join(tmpdir(), "rigel-voice-test-"));
  process.env.HOME = home;
  await mkdir(join(home, ".claude"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = prevHome;
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("voiceConfig", () => {
  test("empty when nothing is set, with the default model", async () => {
    const c = await voiceConfig();
    expect(c.url).toBe("");
    expect(c.apiSecret).toBe("");
    expect(c.model).toBe(DEFAULT_VOICE_MODEL);
  });

  test("env wins over the file, per field", async () => {
    await setVoiceConfig({ url: "wss://file.example", apiKey: "file-key" });
    process.env.LIVEKIT_URL = "wss://env.example";
    const c = await voiceConfig();
    expect(c.url).toBe("wss://env.example");
    expect(c.apiKey).toBe("file-key");
  });

  test("set + read round-trips through the public API", async () => {
    await setVoiceConfig({ apiSecret: "s3cret", openrouterApiKey: "or-key", url: "wss://x" });
    const c = await voiceConfig();
    expect(c.apiSecret).toBe("s3cret");
    expect(c.openrouterApiKey).toBe("or-key");
    const raw = await readFile(join(process.env.HOME!, ".claude", "rigel-voice.json"), "utf8");
    expect(raw).toContain("wss://x");
  });

  test("an empty-string patch field clears the stored value", async () => {
    await setVoiceConfig({ url: "wss://x" });
    await setVoiceConfig({ url: "" });
    expect((await voiceConfig()).url).toBe("");
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
