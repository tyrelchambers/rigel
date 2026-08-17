import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { identityFor, mintVoiceToken, agentConfigResponse, checkWorkerToken, VOICE_ROOM } from "./voiceRoutes";

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

const ENV = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "OPENROUTER_API_KEY", "RIGEL_VOICE_WORKER_TOKEN"];
let prev: Record<string, string | undefined>;

beforeEach(() => {
  prev = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.LIVEKIT_URL = "wss://test.livekit.example";
  process.env.LIVEKIT_API_KEY = "APIkey";
  process.env.LIVEKIT_API_SECRET = "sixty-four-chars-of-secret-material-for-hs256-signing-goes-here!";
  process.env.OPENROUTER_API_KEY = "or-key";
  delete process.env.RIGEL_VOICE_WORKER_TOKEN;
});

afterEach(() => {
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
});

describe("agentConfigResponse", () => {
  test("carries the agent token plus provider keys and model", async () => {
    const res = await agentConfigResponse();
    expect(res?.openrouterApiKey).toBe("or-key");
    expect(res?.model).toBeTruthy();
    expect(decodeJwt(res!.token).sub).toBe("rigel-agent");
  });

  test("null without an OpenRouter key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(await agentConfigResponse()).toBeNull();
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
