import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identityFor, mintVoiceToken, agentConfigResponse, checkWorkerToken, isVoiceWorkerRequest,
  maskedVoiceConfig, newVoiceRoom, voiceConfigPatch, voiceTokenResponse, VOICE_WORKER_HEADER,
} from "./voiceRoutes";
import { createVoiceDispatch, type VoiceJob } from "./voiceDispatch";
import { setVoiceConfig } from "./voiceConfig";
import {
  __setClusterConfigIO,
  __useFakeClusterConfig,
  __resetClusterConfigCache,
  type FakeClusterConfig,
} from "./clusterConfigStore";

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

const ENV = [
  "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "OPENROUTER_API_KEY",
  "RIGEL_VOICE_WORKER_TOKEN", "RIGEL_USER_DATA_DIR",
];
let prev: Record<string, string | undefined>;
let prevHome: string | undefined;
let fake: FakeClusterConfig;
/** Config is per cluster, so every call names the context it belongs to. */
const CTX = "test-cluster";
const ROOM = "rigel-desktop-0a1b2c3d";

beforeEach(async () => {
  fake = __useFakeClusterConfig();
  prev = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  // Any field the env does not set is answered by the cluster's Secret, which
  // the fake starts empty. HOME still points somewhere empty so the one-time
  // local migration finds nothing of the developer's to lift.
  prevHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), "rigel-voice-routes-"));
  process.env.LIVEKIT_URL = "wss://test.livekit.example";
  process.env.LIVEKIT_API_KEY = "APIkey";
  process.env.LIVEKIT_API_SECRET = "sixty-four-chars-of-secret-material-for-hs256-signing-goes-here!";
  process.env.OPENROUTER_API_KEY = "or-key";
  delete process.env.RIGEL_VOICE_WORKER_TOKEN;
});

afterEach(() => {
  __setClusterConfigIO(null);
  __resetClusterConfigCache();
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

describe("newVoiceRoom", () => {
  test("names the role and carries eight hex characters", () => {
    expect(newVoiceRoom("desktop")).toMatch(/^rigel-desktop-[0-9a-f]{8}$/);
    expect(newVoiceRoom("phone")).toMatch(/^rigel-phone-[0-9a-f]{8}$/);
  });

  test("every connection gets a different room", () => {
    const rooms = new Set(Array.from({ length: 50 }, () => newVoiceRoom("desktop")));
    expect(rooms.size).toBe(50);
  });
});

describe("mintVoiceToken", () => {
  test("mints a JWT for exactly the given room with join + data grants", async () => {
    const minted = await mintVoiceToken("desktop", CTX, ROOM);
    expect(minted?.url).toBe("wss://test.livekit.example");
    expect(minted?.identity).toBe("rigel-desktop");
    const payload = decodeJwt(minted!.token) as { sub: string; video: Record<string, unknown> };
    expect(payload.sub).toBe("rigel-desktop");
    expect(payload.video.room).toBe(ROOM);
    expect(payload.video.roomJoin).toBe(true);
    expect(payload.video.canPublishData).toBe(true);
  });

  test("lives for one hour, whatever the role", async () => {
    for (const role of ["desktop", "agent", "phone"] as const) {
      const payload = decodeJwt((await mintVoiceToken(role, CTX, ROOM))!.token) as { exp: number; nbf: number };
      expect(payload.exp - payload.nbf).toBe(3600);
    }
  });

  test("reports the phone identity it minted, so the worker can link that participant", async () => {
    const phone = await mintVoiceToken("phone", CTX, ROOM);
    expect(phone?.identity).toMatch(/^rigel-phone-/);
    expect(decodeJwt(phone!.token).sub).toBe(phone?.identity);
  });

  test("returns null when LiveKit is unconfigured", async () => {
    delete process.env.LIVEKIT_URL;
    expect(await mintVoiceToken("desktop", CTX, ROOM)).toBeNull();
  });

  test("phone tokens cannot publish data; desktop tokens can", async () => {
    const phone = await mintVoiceToken("phone", CTX, ROOM);
    const desktop = await mintVoiceToken("desktop", CTX, ROOM);
    const phonePayload = decodeJwt(phone!.token) as { video: Record<string, unknown> };
    const desktopPayload = decodeJwt(desktop!.token) as { video: Record<string, unknown> };
    expect(phonePayload.video.canPublishData).toBeFalsy();
    expect(desktopPayload.video.canPublishData).toBe(true);
  });

  test("agent tokens carry the agent kind claim, the agent marker, and canUpdateOwnMetadata", async () => {
    const agent = await mintVoiceToken("agent", CTX, ROOM);
    const payload = decodeJwt(agent!.token) as { kind?: string; video: Record<string, unknown> };
    expect(payload.kind).toBe("agent");
    expect(payload.video.agent).toBe(true);
    expect(payload.video.canUpdateOwnMetadata).toBe(true);
  });

  test("desktop tokens carry canUpdateOwnMetadata but neither the agent kind nor the marker", async () => {
    const desktop = await mintVoiceToken("desktop", CTX, ROOM);
    const payload = decodeJwt(desktop!.token) as { kind?: string; video: Record<string, unknown> };
    expect(payload.video.canUpdateOwnMetadata).toBe(true);
    expect(payload.video.agent).toBeFalsy();
    expect(payload.kind).toBeUndefined();
  });

  test("phone tokens carry neither the agent marker nor canUpdateOwnMetadata", async () => {
    const phone = await mintVoiceToken("phone", CTX, ROOM);
    const payload = decodeJwt(phone!.token) as { video: Record<string, unknown> };
    expect(payload.video.agent).toBeFalsy();
    expect(payload.video.canUpdateOwnMetadata).toBeFalsy();
    expect(payload.video.canPublishData).toBeFalsy();
  });
});

describe("agentConfigResponse", () => {
  test("carries the agent token for the room plus provider keys and model", async () => {
    const res = await agentConfigResponse(CTX, ROOM);
    expect(res?.openrouterApiKey).toBe("or-key");
    expect(res?.model).toBeTruthy();
    expect(res?.apiKey).toBe("APIkey");
    expect(res?.apiSecret).toBe("sixty-four-chars-of-secret-material-for-hs256-signing-goes-here!");
    expect(res?.sttModel).toBeTruthy();
    expect(res?.ttsModel).toBeTruthy();
    const payload = decodeJwt(res!.token) as { sub: string; video: Record<string, unknown> };
    expect(payload.sub).toBe("rigel-agent");
    expect(payload.video.room).toBe(ROOM);
    expect(res).not.toHaveProperty("identity");
  });

  test("null without an OpenRouter key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(await agentConfigResponse(CTX, ROOM)).toBeNull();
  });
});

describe("voiceTokenResponse", () => {
  test("without a worker attached, 503 naming the agent", async () => {
    const res = await voiceTokenResponse("desktop", CTX, createVoiceDispatch());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "The voice agent isn't running." });
  });

  test("hands the worker a job for a fresh room and the client a token for the same room", async () => {
    const hub = createVoiceDispatch();
    const jobs: VoiceJob[] = [];
    hub.subscribe((j) => jobs.push(j));
    const res = await voiceTokenResponse("desktop", CTX, hub);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; token: string; room: string };
    expect(body.url).toBe("wss://test.livekit.example");
    expect(body.room).toMatch(/^rigel-desktop-[0-9a-f]{8}$/);
    expect((decodeJwt(body.token) as { video: { room: string } }).video.room).toBe(body.room);

    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.room).toBe(body.room);
    expect(job.role).toBe("desktop");
    expect(job.clientIdentity).toBe("rigel-desktop");
    expect(job.context).toBe(CTX);
    const agent = decodeJwt(job.config.token) as { sub: string; video: { room: string } };
    expect(agent.sub).toBe("rigel-agent");
    expect(agent.video.room).toBe(body.room);
    expect(job.config.openrouterApiKey).toBe("or-key");
  });

  test("a phone job links the phone identity its token was minted for", async () => {
    const hub = createVoiceDispatch();
    const jobs: VoiceJob[] = [];
    hub.subscribe((j) => jobs.push(j));
    const body = (await (await voiceTokenResponse("phone", CTX, hub)).json()) as { token: string };
    expect(jobs[0]!.role).toBe("phone");
    expect(jobs[0]!.clientIdentity).toBe(decodeJwt(body.token).sub);
  });

  test("409 naming what is missing, and nothing dispatched, when voice is not configured", async () => {
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.OPENROUTER_API_KEY;
    const hub = createVoiceDispatch();
    const listener = vi.fn();
    hub.subscribe(listener);
    const res = await voiceTokenResponse("desktop", CTX, hub);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "voice is not configured", missing: ["apiSecret", "openrouterApiKey"] });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("maskedVoiceConfig", () => {
  test("reports secrets as set/unset booleans, never as values", async () => {
    const m = await maskedVoiceConfig(CTX);
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
    await setVoiceConfig(CTX, { apiKey: "from-cluster" });
    const m = await maskedVoiceConfig(CTX);
    expect(m.env.url).toBe("LIVEKIT_URL");
    expect(m.env.apiSecret).toBe("LIVEKIT_API_SECRET");
    expect(m.env.apiKey).toBeUndefined();
    expect(m.apiKey).toBe("from-cluster");
  });

  test("carries the models and the feature status", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const m = await maskedVoiceConfig(CTX);
    expect(m.model).toBeTruthy();
    expect(m.sttModel).toBeTruthy();
    expect(m.ttsModel).toBeTruthy();
    expect(m.status).toEqual({ enabled: false, configured: false });
  });

  test("names the cluster the config belongs to", async () => {
    const m = await maskedVoiceConfig(CTX);
    expect(m.cluster.context).toBe(CTX);
    expect(m.cluster.state).toBe("ok");
    expect(m.cluster.secret).toBe("rigel-user-config");
  });

  test("an unreachable cluster is reported as such, not as unconfigured", async () => {
    fake.reachable = false;
    const m = await maskedVoiceConfig(CTX);
    expect(m.cluster.state).toBe("unavailable");
    expect(m.cluster.message).toMatch(/connection to the server/);
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
