import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identityFor, mintVoiceToken, agentConfigResponse, checkWorkerToken, isVoiceWorkerRequest,
  maskedVoiceConfig, voiceConfigPatch, VOICE_ROOM, VOICE_WORKER_HEADER,
} from "./voiceRoutes";
import { setVoiceConfig } from "./voiceConfig";

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

const ENV = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "OPENROUTER_API_KEY", "RIGEL_VOICE_WORKER_TOKEN"];
let prev: Record<string, string | undefined>;
let prevHome: string | undefined;

beforeEach(async () => {
  prev = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  // voiceConfig falls back to ~/.claude/rigel-voice.json for any field the env
  // does not set, so a test that deletes one env var is otherwise answered by
  // whatever the developer has configured on this machine. Point HOME at an
  // empty directory so "unconfigured" means unconfigured.
  prevHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), "rigel-voice-routes-"));
  process.env.LIVEKIT_URL = "wss://test.livekit.example";
  process.env.LIVEKIT_API_KEY = "APIkey";
  process.env.LIVEKIT_API_SECRET = "sixty-four-chars-of-secret-material-for-hs256-signing-goes-here!";
  process.env.OPENROUTER_API_KEY = "or-key";
  delete process.env.RIGEL_VOICE_WORKER_TOKEN;
});

afterEach(() => {
  process.env.HOME = prevHome;
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("identityFor", () => {
  test("stable identities for desktop and agent, unique-ish for phone", () => {
    expect(identityFor("desktop")).toBe("rigel-desktop");
    expect(identityFor("agent")).toBe("rigel-agent");
    expect(identityFor("phone")).toMatch(/^rigel-phone-/);
  });
});

describe("mintVoiceToken", () => {
  test("mints a JWT for the fixed room with join + data grants", async () => {
    const minted = await mintVoiceToken("desktop");
    expect(minted?.url).toBe("wss://test.livekit.example");
    const payload = decodeJwt(minted!.token) as { sub: string; video: Record<string, unknown> };
    expect(payload.sub).toBe("rigel-desktop");
    expect(payload.video.room).toBe(VOICE_ROOM);
    expect(payload.video.roomJoin).toBe(true);
    expect(payload.video.canPublishData).toBe(true);
  });

  test("returns null when LiveKit is unconfigured", async () => {
    delete process.env.LIVEKIT_URL;
    expect(await mintVoiceToken("desktop")).toBeNull();
  });

  test("phone tokens cannot publish data; desktop tokens can", async () => {
    const phone = await mintVoiceToken("phone");
    const desktop = await mintVoiceToken("desktop");
    const phonePayload = decodeJwt(phone!.token) as { video: Record<string, unknown> };
    const desktopPayload = decodeJwt(desktop!.token) as { video: Record<string, unknown> };
    expect(phonePayload.video.canPublishData).toBeFalsy();
    expect(desktopPayload.video.canPublishData).toBe(true);
  });

  test("agent tokens carry the agent kind claim, the agent marker, and canUpdateOwnMetadata", async () => {
    const agent = await mintVoiceToken("agent");
    const payload = decodeJwt(agent!.token) as { kind?: string; video: Record<string, unknown> };
    expect(payload.kind).toBe("agent");
    expect(payload.video.agent).toBe(true);
    expect(payload.video.canUpdateOwnMetadata).toBe(true);
  });

  test("desktop tokens carry canUpdateOwnMetadata but neither the agent kind nor the marker", async () => {
    const desktop = await mintVoiceToken("desktop");
    const payload = decodeJwt(desktop!.token) as { kind?: string; video: Record<string, unknown> };
    expect(payload.video.canUpdateOwnMetadata).toBe(true);
    expect(payload.video.agent).toBeFalsy();
    expect(payload.kind).toBeUndefined();
  });

  test("phone tokens carry neither the agent marker nor canUpdateOwnMetadata", async () => {
    const phone = await mintVoiceToken("phone");
    const payload = decodeJwt(phone!.token) as { video: Record<string, unknown> };
    expect(payload.video.agent).toBeFalsy();
    expect(payload.video.canUpdateOwnMetadata).toBeFalsy();
    expect(payload.video.canPublishData).toBeFalsy();
  });
});

describe("agentConfigResponse", () => {
  test("carries the agent token plus provider keys and model", async () => {
    const res = await agentConfigResponse();
    expect(res?.openrouterApiKey).toBe("or-key");
    expect(res?.model).toBeTruthy();
    expect(res?.apiKey).toBe("APIkey");
    expect(res?.apiSecret).toBe("sixty-four-chars-of-secret-material-for-hs256-signing-goes-here!");
    expect(res?.sttModel).toBeTruthy();
    expect(res?.ttsModel).toBeTruthy();
    expect(decodeJwt(res!.token).sub).toBe("rigel-agent");
  });

  test("null without an OpenRouter key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(await agentConfigResponse()).toBeNull();
  });
});

describe("maskedVoiceConfig", () => {
  test("reports secrets as set/unset booleans, never as values", async () => {
    const m = await maskedVoiceConfig();
    expect(m.url).toBe("wss://test.livekit.example");
    expect(m.apiKey).toBe("APIkey");
    expect(m.apiSecretSet).toBe(true);
    expect(m.openrouterApiKeySet).toBe(true);
    const secrets = [process.env.LIVEKIT_API_SECRET, process.env.OPENROUTER_API_KEY];
    expect(JSON.stringify(m).includes(secrets[0]!)).toBe(false);
    expect(JSON.stringify(m).includes(secrets[1]!)).toBe(false);
  });

  test("names the env var supplying each env-sourced field", async () => {
    delete process.env.LIVEKIT_API_KEY;
    await setVoiceConfig({ apiKey: "from-file" });
    const m = await maskedVoiceConfig();
    expect(m.env.url).toBe("LIVEKIT_URL");
    expect(m.env.apiSecret).toBe("LIVEKIT_API_SECRET");
    expect(m.env.apiKey).toBeUndefined();
    expect(m.apiKey).toBe("from-file");
  });

  test("carries the models and the feature status", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const m = await maskedVoiceConfig();
    expect(m.model).toBeTruthy();
    expect(m.sttModel).toBeTruthy();
    expect(m.ttsModel).toBeTruthy();
    expect(m.status).toEqual({ enabled: false, configured: false });
  });
});

describe("voiceConfigPatch", () => {
  test("keeps known string fields, including the empty string that clears one", () => {
    expect(voiceConfigPatch({ url: "wss://x", apiSecret: "" })).toEqual({ url: "wss://x", apiSecret: "" });
  });

  test("drops unknown keys and non-string values rather than coercing them", () => {
    expect(voiceConfigPatch({ url: 7, nope: "x", model: null, sttModel: "deepgram/nova-2" })).toEqual({
      sttModel: "deepgram/nova-2",
    });
  });

  test("an absent field stays absent, so setVoiceConfig leaves it alone", () => {
    expect("apiKey" in voiceConfigPatch({ url: "wss://x" })).toBe(false);
    expect(voiceConfigPatch(null)).toEqual({});
    expect(voiceConfigPatch("not an object")).toEqual({});
  });
});

describe("checkWorkerToken", () => {
  test("denies when the expected token is unset (this route returns keys)", () => {
    expect(checkWorkerToken("anything")).toBe(false);
  });

  test("constant-time match against RIGEL_VOICE_WORKER_TOKEN", () => {
    process.env.RIGEL_VOICE_WORKER_TOKEN = "wt-123";
    expect(checkWorkerToken("wt-123")).toBe(true);
    expect(checkWorkerToken("wrong")).toBe(false);
    expect(checkWorkerToken(null)).toBe(false);
  });
});

describe("isVoiceWorkerRequest", () => {
  const reqWith = (headers: Record<string, string>) =>
    new Request("http://localhost/api/action", { method: "POST", headers });

  test("true only when the request carries a valid worker token", () => {
    process.env.RIGEL_VOICE_WORKER_TOKEN = "wt-123";
    expect(isVoiceWorkerRequest(reqWith({ [VOICE_WORKER_HEADER]: "wt-123" }))).toBe(true);
    expect(isVoiceWorkerRequest(reqWith({ [VOICE_WORKER_HEADER]: "wrong" }))).toBe(false);
  });

  test("false for a renderer request, which never holds the worker token", () => {
    process.env.RIGEL_VOICE_WORKER_TOKEN = "wt-123";
    expect(isVoiceWorkerRequest(reqWith({ "x-rigel-session": "session-secret" }))).toBe(false);
  });

  test("false when the expected token is unset, so voice is never inferred", () => {
    delete process.env.RIGEL_VOICE_WORKER_TOKEN;
    expect(isVoiceWorkerRequest(reqWith({ [VOICE_WORKER_HEADER]: "anything" }))).toBe(false);
  });
});
