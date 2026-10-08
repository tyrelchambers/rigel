import { EventEmitter } from "node:events";
import { initializeLogger, type voice as Voice } from "@livekit/agents";
import { DisconnectReason } from "@livekit/rtc-node";
import type { VoiceJob } from "@rigel/server/src/voiceDispatch";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ServerClient } from "./serverClient.js";

const h = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const behavior = { failConnect: false, failConstruct: false, failStart: false, sayThrows: false };
  const rooms: FakeRoom[] = [];
  const sessions: FakeAgentSession[] = [];
  class FakeRoom extends EventEmitter {
    remoteParticipants = new Map<string, { identity: string }>();
    localParticipant = { identity: "rigel-agent", kind: 4, publishData: async () => {} };
    connect = vi.fn(async () => {
      if (behavior.failConnect) throw new Error("could not connect");
    });
    disconnect = vi.fn(async () => {
      this.emit("disconnected");
    });
    constructor() {
      super();
      rooms.push(this);
    }
  }
  class FakeAgentSession extends EventEmitter {
    _closing = false;
    agentState = "listening";
    agent: unknown;
    start = vi.fn(async (opts: { agent: unknown }) => {
      if (behavior.failStart) throw new Error("start failed");
      this.agent = opts.agent;
    });
    close = vi.fn(async () => {
      this._closing = true;
      await new Promise((r) => setTimeout(r, 5));
      this.emit("close", { type: "close", reason: "user_initiated", error: null, createdAt: 0 });
    });
    say = vi.fn(() => {
      if (behavior.sayThrows || this._closing) throw new Error("AgentSession is closing");
    });
    updateOptions = vi.fn(() => {
      if (this._closing) throw new Error("AgentSession is closing");
    });
    constructor(public opts?: { connOptions?: { llmConnOptions?: { timeoutMs?: number; maxRetry?: number } } }) {
      super();
      if (behavior.failConstruct) throw new Error("bad model");
      sessions.push(this);
    }
  }
  class Dummy {}
  return { behavior, rooms, sessions, FakeRoom, FakeAgentSession, Dummy };
});

vi.mock("@livekit/rtc-node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@livekit/rtc-node")>()),
  Room: h.FakeRoom,
}));
vi.mock("@livekit/agents", async (importOriginal) => {
  const real = await importOriginal<typeof import("@livekit/agents")>();
  return {
    ...real,
    voice: { ...real.voice, AgentSession: h.FakeAgentSession },
    inference: { ...real.inference, STT: h.Dummy, TTS: h.Dummy, TurnDetector: h.Dummy },
  };
});
vi.mock("@livekit/agents-plugin-openai", () => ({ LLM: h.Dummy }));

const { runSession } = await import("./session.js");

initializeLogger({ pretty: false, level: "silent" });

const JOB: VoiceJob = {
  room: "rigel-desktop-0a1b2c3d",
  role: "desktop",
  clientIdentity: "rigel-desktop",
  context: "prod",
  config: {
    url: "wss://x",
    token: "t",
    model: "m",
    sttModel: "s",
    ttsModel: "t",
    apiKey: "k",
    apiSecret: "secret",
    openrouterApiKey: "or",
  },
};

const server = {
  previewAction: async () => ["kubectl", "--context", "prod", "delete", "namespace", "staging"],
} as unknown as ServerClient;

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

beforeEach(() => {
  Object.assign(h.behavior, { failConnect: false, failConstruct: false, failStart: false, sayThrows: false });
  h.rooms.length = 0;
  h.sessions.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function proposeDelete(): Promise<void> {
  const agent = h.sessions[0]!.agent as Voice.Agent;
  await agent.toolCtx.getFunctionTool("proposeMutation")!.execute(
    { action: { kind: "deleteNamespace", label: "Delete staging", name: "staging" } } as never,
    { toolCallId: "call-1", abortSignal: new AbortController().signal, ctx: {} } as never,
  );
}

async function liveSession() {
  const run = runSession(JOB, server);
  await vi.waitFor(() => expect(h.rooms).toHaveLength(1));
  const room = h.rooms[0]!;
  room.remoteParticipants.set(JOB.clientIdentity, { identity: JOB.clientIdentity });
  await run;
  return { room, session: h.sessions[0]! };
}

describe("runSession data frames", () => {
  test("a result arriving after teardown began is not spoken, and nothing throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { room, session } = await liveSession();
    await proposeDelete();

    room.emit("participantDisconnected", {
      identity: JOB.clientIdentity,
      disconnectReason: DisconnectReason.CLIENT_INITIATED,
    });
    expect(session._closing).toBe(true);
    expect(() =>
      room.emit(
        "dataReceived",
        encode({ id: "call-1", ok: true, summary: "ran" }),
        { identity: JOB.clientIdentity },
        1,
        "rigel.action.result",
      ),
    ).not.toThrow();
    expect(() =>
      room.emit("dataReceived", encode({ names: ["web"] }), { identity: JOB.clientIdentity }, 1, "rigel.keyterms"),
    ).not.toThrow();
    expect(session.say).not.toHaveBeenCalled();
    expect(session.updateOptions).not.toHaveBeenCalled();
    error.mockRestore();
  });

  test("say refusing on a running session is logged, not thrown into the emitter", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { room, session } = await liveSession();
    await proposeDelete();
    h.behavior.sayThrows = true;

    expect(() =>
      room.emit(
        "dataReceived",
        encode({ id: "call-1", ok: true, summary: "ran" }),
        { identity: JOB.clientIdentity },
        1,
        "rigel.action.result",
      ),
    ).not.toThrow();
    expect(session.say).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("runSession model timeout", () => {
  test("a slow first token gets 30 s instead of the SDK's 10 s, keeping the retries", async () => {
    await liveSession();
    expect(h.sessions[0]!.opts?.connOptions?.llmConnOptions).toEqual({ timeoutMs: 30_000 });
  });
});

describe("runSession setup failures", () => {
  test("a constructor throwing after connect still leaves the room", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.behavior.failConstruct = true;
    await expect(runSession(JOB, server)).resolves.toBeUndefined();
    expect(h.rooms[0]!.connect).toHaveBeenCalled();
    expect(h.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a start that fails closes the session and leaves the room", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.behavior.failStart = true;
    await expect(runSession(JOB, server)).resolves.toBeUndefined();
    expect(h.sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(h.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a failed connect leaves the half-open room", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.behavior.failConnect = true;
    await expect(runSession(JOB, server)).resolves.toBeUndefined();
    expect(h.rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(h.sessions).toHaveLength(0);
  });
});
