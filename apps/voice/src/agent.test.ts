import { initializeLogger, llm, voice } from "@livekit/agents";
import { ACTION_KINDS, type SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildAgent, CONTEXT_HEADING, refreshInstructions, SENT_TO_DESKTOP, unknownKindRefusal } from "./agent.js";
import type { PublishRoom } from "./publish.js";
import type { ServerClient } from "./serverClient.js";
import { DESKTOP_IDENTITY, applyDataFrame, emptySessionState, type SessionState } from "./state.js";

initializeLogger({ pretty: false, level: "silent" });

interface Frame {
  topic: string;
  payload: Record<string, unknown>;
}

function fakeRoom(identities: string[] = [DESKTOP_IDENTITY]): { room: PublishRoom; frames: Frame[] } {
  const frames: Frame[] = [];
  return {
    frames,
    room: {
      localParticipant: {
        publishData: async (data, options) => {
          frames.push({ topic: options.topic, payload: JSON.parse(new TextDecoder().decode(data)) });
        },
      },
      remoteParticipants: new Map(identities.map((identity) => [identity, { identity }])),
    },
  };
}

interface FakeServer extends ServerClient {
  previews: SuggestedAction[];
}

function fakeServer(overrides: Partial<ServerClient> = {}): FakeServer {
  const previews: SuggestedAction[] = [];
  return {
    previews,
    agentConfig: async () => {
      throw new Error("not used");
    },
    previewAction: async (action) => {
      previews.push(action);
      return ["kubectl", "--context", "prod", "rollout", "restart", "deployment/web"];
    },
    ...overrides,
  };
}

const restart: SuggestedAction = { kind: "restart", label: "Restart web", name: "web", namespace: "prod" };

/** The ToolOptions shape the SDK hands a tool: { ctx, toolCallId, abortSignal }. */
function toolOpts(callId = "call-1"): { opts: never; fireSpeechDone: () => void } {
  const callbacks: Array<() => void> = [];
  return {
    fireSpeechDone: () => callbacks.forEach((cb) => cb()),
    opts: {
      toolCallId: callId,
      abortSignal: new AbortController().signal,
      ctx: { speechHandle: { addDoneCallback: (cb: () => void) => callbacks.push(cb) } },
    } as never,
  };
}

function propose(agent: voice.Agent, action: unknown, opts: never): Promise<string> {
  const tool = agent.toolCtx.getFunctionTool("proposeMutation");
  if (!tool) throw new Error("proposeMutation is not registered");
  return tool.execute({ action }, opts) as Promise<string>;
}

/** A live AgentSession so `this.session.say(...)` and StopResponse take the real path. */
async function startSession(
  state: SessionState,
  server: ServerClient,
  room: PublishRoom,
  responses: voice.testing.FakeLLMResponse[] = [],
) {
  const agent = buildAgent(state, server, room);
  const session = new voice.AgentSession({ llm: new voice.testing.FakeLLM(responses) });
  const said: string[] = [];
  const realSay = session.say.bind(session);
  session.say = ((text: string, options?: Parameters<typeof realSay>[1]) => {
    said.push(String(text));
    return realSay(text, options);
  }) as typeof session.say;
  await session.start({ agent });
  return { agent, session, said };
}

function userTurn(agent: voice.Agent, text: string): Promise<void> {
  return agent.onUserTurnCompleted(new llm.ChatContext(), new llm.ChatMessage({ role: "user", content: text }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildAgent", () => {
  const agentOf = (state = emptySessionState()) => buildAgent(state, fakeServer(), fakeRoom().room);

  test("exposes readCluster with a closed verb set", () => {
    const tool = agentOf().toolCtx.getFunctionTool("readCluster");
    const shape = (tool?.parameters as { shape: { verb: { options: string[] } } }).shape;
    expect(shape.verb.options).toEqual(["get", "describe", "logs", "top", "events"]);
  });

  test("the instructions name the active context the session was built with", () => {
    const state = emptySessionState();
    state.activeContext = "kind-rigel";
    expect(agentOf(state).instructions).toContain("kind-rigel");
  });

  test("the context the desktop publishes after connect reaches the instructions", async () => {
    const state = emptySessionState();
    const agent = agentOf(state);
    expect(agent.instructions).toContain("No kubectl context is selected");

    applyDataFrame(state, DESKTOP_IDENTITY, "rigel.state", JSON.stringify({ activeContext: "kind-rigel" }));
    await refreshInstructions(agent, state);
    expect(agent.instructions).toContain("kind-rigel");
    expect(agent.instructions).not.toContain("No kubectl context is selected");
  });

  test("clearing the context puts the no-context wording back", async () => {
    const state = emptySessionState();
    state.activeContext = "kind-rigel";
    const agent = agentOf(state);
    state.activeContext = null;
    await refreshInstructions(agent, state);
    expect(agent.instructions).toContain("No kubectl context is selected");
  });

  test("a read the builder rejects comes back as text, not a thrown tool call", async () => {
    const tool = agentOf().toolCtx.getFunctionTool("readCluster");
    await expect(tool!.execute({ verb: "describe", kind: "pod" }, {} as never)).resolves.toMatch(
      /describe needs kind and name/,
    );
  });

  test("a completed user turn absorbs the buffered context lines exactly once", async () => {
    const state = emptySessionState();
    state.contextLines = ["deployment/web in prod: 1/3 ready", "pod/web-7 in prod: CrashLoopBackOff"];
    const { agent } = await startSession(state, fakeServer(), fakeRoom().room);
    const message = new llm.ChatMessage({ role: "user", content: "what is wrong with web" });

    await agent.onUserTurnCompleted(new llm.ChatContext(), message);
    expect(message.textContent).toContain("what is wrong with web");
    expect(message.textContent).toContain(`${CONTEXT_HEADING}\ndeployment/web in prod: 1/3 ready`);
    expect(state.contextLines).toEqual([]);

    await agent.onUserTurnCompleted(new llm.ChatContext(), message);
    expect(message.content).toHaveLength(2);
  });

  test("a turn with no buffered context is left alone", async () => {
    const { agent } = await startSession(emptySessionState(), fakeServer(), fakeRoom().room);
    const message = new llm.ChatMessage({ role: "user", content: "how many nodes" });
    await agent.onUserTurnCompleted(new llm.ChatContext(), message);
    expect(message.content).toEqual(["how many nodes"]);
  });
});

describe("proposeMutation routing", () => {
  test("a reversible kind still goes to the desktop, and the reply never asks for a spoken confirmation", async () => {
    const state = emptySessionState();
    state.activeContext = "prod";
    const server = fakeServer();
    const { room, frames } = fakeRoom();
    const { opts } = toolOpts("call-42");

    const out = await propose(buildAgent(state, server, room), restart, opts);

    expect(server.previews).toEqual([restart]);
    expect(out).toMatch(/desktop/);
    expect(out).toMatch(/never ask them to confirm out loud/);
    expect(state.awaitingClick.get("call-42")).toBe(restart.label);
    expect(frames).toEqual([
      {
        topic: "rigel.action",
        payload: {
          id: "call-42",
          action: restart,
          command: "kubectl --context prod rollout restart deployment/web",
        },
      },
    ]);
  });

  test("an irreversible kind takes the same single route", async () => {
    const state = emptySessionState();
    const server = fakeServer();
    const { room, frames } = fakeRoom();
    const del: SuggestedAction = { kind: "deletePod", label: "Delete web-1", pod: "web-1" };

    const out = await propose(buildAgent(state, server, room), del, toolOpts().opts);

    expect(out).toMatch(/desktop/);
    expect(frames[0]!.payload.action).toEqual(del);
    // Recorded so the desktop's rigel.action.result can be spoken. Nothing
    // else on this side remembers a proposal.
    expect(state.awaitingClick.get("call-1")).toBe("Delete web-1");
  });

  test("the unpreviewable kinds are never previewed, because /api/action cannot build them", async () => {
    const server = fakeServer({
      previewAction: async () => {
        throw new Error("previewAction must not be called for these kinds");
      },
    });
    const { room, frames } = fakeRoom();
    const agent = buildAgent(emptySessionState(), server, room);

    for (const kind of ["purge", "applyManifest", "proposeRepoFix"]) {
      await expect(propose(agent, { kind, label: kind }, toolOpts().opts)).resolves.toMatch(/desktop/);
    }
    expect(frames.map((f) => f.payload.command)).toEqual([null, null, null]);
  });

  test("no desktop in the room is refused and publishes nothing", async () => {
    const state = emptySessionState();
    const { room, frames } = fakeRoom(["phone-1"]);

    const out = await propose(
      buildAgent(state, fakeServer(), room),
      { kind: "deleteNamespace", label: "Delete staging", name: "staging" },
      toolOpts().opts,
    );

    expect(out).toMatch(/^Refused:/);
    expect(out).toMatch(/no desktop session/);
    expect(frames).toEqual([]);
    expect(state.awaitingClick.size).toBe(0);
  });

  test("a blocked command is refused rather than routed anywhere", async () => {
    const state = emptySessionState();
    const server = fakeServer({ previewAction: async () => ["kubectl", "port-forward", "svc/web", "8080:80"] });
    const { room, frames } = fakeRoom();

    const out = await propose(buildAgent(state, server, room), restart, toolOpts().opts);

    expect(out).toMatch(/^Refused:/);
    expect(frames).toEqual([]);
    expect(state.awaitingClick.size).toBe(0);
  });

  test("an unknown kind is refused before anything is previewed or published", async () => {
    const server = fakeServer({
      previewAction: async () => {
        throw new Error("must not preview an unknown kind");
      },
    });
    const { room, frames } = fakeRoom();

    const out = await propose(buildAgent(emptySessionState(), server, room), { kind: "nukeCluster" }, toolOpts().opts);

    expect(out).toMatch(/^Refused: unknown action kind "nukeCluster"/);
    expect(frames).toEqual([]);
  });

  test("the unknown-kind refusal names the route the model should have taken", () => {
    const out = unknownKindRefusal("patch");

    expect(out).toContain('"patch"');
    expect(out).toContain('"command"');
    expect(out).toContain('"annotate"');
    for (const kind of ACTION_KINDS) expect(out).toContain(kind);
  });

  test("a preview the server cannot build is refused, not guessed at", async () => {
    const server = fakeServer({
      previewAction: async () => {
        throw new Error("action preview failed: 400");
      },
    });
    const state = emptySessionState();

    const out = await propose(buildAgent(state, server, fakeRoom().room), restart, toolOpts().opts);

    expect(out).toMatch(/^Refused: the app could not build that command/);
    expect(state.awaitingClick.size).toBe(0);
  });
});

describe("the live LLM-driven proposal turn", () => {
  test("a model tool call publishes a proposal and nothing spoken afterwards can run it", async () => {
    const state = emptySessionState();
    state.activeContext = "prod";
    const server = fakeServer();
    const { room, frames } = fakeRoom();
    const { agent, session } = await startSession(state, server, room, [
      {
        input: "restart web",
        toolCalls: [{ name: "proposeMutation", args: { action: restart } }],
      },
      {
        input: JSON.stringify(SENT_TO_DESKTOP),
        content: "It's waiting in the popover for you to run.",
        duration: 50,
      },
    ]);

    const result = await session.run({ userInput: "restart web" });
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    result.expect.containsFunctionCall({ name: "proposeMutation" });
    expect(frames[0]!.payload.action).toEqual(restart);
    expect(state.awaitingClick.get("call-1") ?? state.awaitingClick.size).toBeTruthy();

    // The word that used to execute is now an ordinary turn: it neither
    // throws StopResponse nor reaches the server, because the worker has no
    // way to run anything at all.
    await expect(userTurn(agent, "confirm")).resolves.toBeUndefined();
    expect(server).not.toHaveProperty("runAction");
  }, 20_000);
});
