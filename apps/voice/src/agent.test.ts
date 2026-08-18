import { initializeLogger, llm, voice } from "@livekit/agents";
import type { SuggestedAction } from "@rigel/k8s/src/actionBlocks";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildAgent, CONFIRM_PROMPT, CONTEXT_HEADING, refreshInstructions } from "./agent.js";
import { PENDING_TTL_MS } from "./mutationFlow.js";
import type { PublishRoom } from "./publish.js";
import type { ActionResult, ServerClient } from "./serverClient.js";
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
  runs: SuggestedAction[];
}

function fakeServer(overrides: Partial<ServerClient> = {}): FakeServer {
  const previews: SuggestedAction[] = [];
  const runs: SuggestedAction[] = [];
  return {
    previews,
    runs,
    agentConfig: async () => {
      throw new Error("not used");
    },
    previewAction: async (action) => {
      previews.push(action);
      return ["kubectl", "--context", "prod", "rollout", "restart", "deployment/web"];
    },
    runAction: async (action) => {
      runs.push(action);
      return { code: 0, stdout: "restarted", stderr: "" } satisfies ActionResult;
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
  test("a reversible kind arms the pending slot and publishes a voice-tier frame", async () => {
    const state = emptySessionState();
    state.activeContext = "prod";
    const server = fakeServer();
    const { room, frames } = fakeRoom();
    const { opts } = toolOpts("call-42");

    const out = await propose(buildAgent(state, server, room), restart, opts);

    expect(server.previews).toEqual([restart]);
    expect(out).toContain("kubectl --context prod rollout restart deployment/web");
    expect(out).toContain(CONFIRM_PROMPT);
    expect(state.pending).toMatchObject({ id: "call-42", action: restart });
    expect(frames).toEqual([
      {
        topic: "rigel.action",
        payload: {
          id: "call-42",
          tier: "voice",
          action: restart,
          command: "kubectl --context prod rollout restart deployment/web",
        },
      },
    ]);
  });

  test("an irreversible kind goes to the desktop popover and never arms the slot", async () => {
    const state = emptySessionState();
    const server = fakeServer();
    const { room, frames } = fakeRoom();
    const del: SuggestedAction = { kind: "deletePod", label: "Delete web-1", pod: "web-1" };

    const out = await propose(buildAgent(state, server, room), del, toolOpts().opts);

    expect(out).toMatch(/desktop/);
    expect(state.pending).toBeNull();
    expect(frames[0]!.payload.tier).toBe("click");
  });

  test("click-required kinds are never previewed, because /api/action cannot build them", async () => {
    const server = fakeServer({
      previewAction: async () => {
        throw new Error("previewAction must not be called for click-required kinds");
      },
    });
    const { room, frames } = fakeRoom();
    const agent = buildAgent(emptySessionState(), server, room);

    for (const kind of ["purge", "applyManifest", "proposeRepoFix"]) {
      await expect(propose(agent, { kind, label: kind }, toolOpts().opts)).resolves.toMatch(/desktop/);
    }
    expect(frames.map((f) => f.payload.command)).toEqual([null, null, null]);
  });

  test("an irreversible kind with no desktop in the room is refused and publishes nothing", async () => {
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
    expect(state.pending).toBeNull();
  });

  test("a voice kind whose previewed command tiers destructive is downgraded to click", async () => {
    const state = emptySessionState();
    const server = fakeServer({
      previewAction: async () => ["kubectl", "--context", "prod", "delete", "deployment", "web"],
    });
    const { room, frames } = fakeRoom();

    await propose(buildAgent(state, server, room), restart, toolOpts().opts);

    expect(frames[0]!.payload.tier).toBe("click");
    expect(state.pending).toBeNull();
  });

  test("a blocked command is refused rather than routed anywhere", async () => {
    const state = emptySessionState();
    const server = fakeServer({ previewAction: async () => ["kubectl", "port-forward", "svc/web", "8080:80"] });
    const { room, frames } = fakeRoom();

    const out = await propose(buildAgent(state, server, room), restart, toolOpts().opts);

    expect(out).toMatch(/^Refused:/);
    expect(frames).toEqual([]);
    expect(state.pending).toBeNull();
  });

  test("an unknown kind is refused before anything is previewed or published", async () => {
    const server = fakeServer({
      previewAction: async () => {
        throw new Error("must not preview an unknown kind");
      },
    });
    const { room, frames } = fakeRoom();

    const out = await propose(buildAgent(emptySessionState(), server, room), { kind: "nukeCluster" }, toolOpts().opts);

    expect(out).toMatch(/^Refused: unknown action kind/);
    expect(frames).toEqual([]);
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
    expect(state.pending).toBeNull();
  });
});

describe("the spoken-confirmation gate", () => {
  async function armed(server: ServerClient = fakeServer()) {
    const state = emptySessionState();
    state.activeContext = "prod";
    const { room, frames } = fakeRoom();
    const started = await startSession(state, server, room);
    const { opts, fireSpeechDone } = toolOpts("call-7");
    await propose(started.agent, restart, opts);
    frames.length = 0;
    return { ...started, state, frames, fireSpeechDone, server: server as FakeServer };
  }

  test("the word confirm runs the action, speaks the outcome, and suppresses the LLM turn", async () => {
    const { agent, state, frames, said, server } = await armed();

    await expect(userTurn(agent, "Confirm.")).rejects.toBeInstanceOf(voice.StopResponse);

    expect(server.runs).toEqual([restart]);
    expect(said).toEqual(["Done. Restart web completed."]);
    expect(frames).toEqual([{ topic: "rigel.action.result", payload: { id: "call-7", ok: true, summary: "ran" } }]);
    expect(state.pending).toBeNull();
  });

  test("cancel speaks, publishes a cancelled result, and never touches the cluster", async () => {
    const { agent, state, frames, said, server } = await armed();

    await expect(userTurn(agent, "no, cancel that")).rejects.toBeInstanceOf(voice.StopResponse);

    expect(server.runs).toEqual([]);
    expect(said).toEqual(["Cancelled. Nothing was changed."]);
    expect(frames).toEqual([
      { topic: "rigel.action.result", payload: { id: "call-7", ok: false, summary: "cancelled" } },
    ]);
    expect(state.pending).toBeNull();
  });

  test("a bare affirmative never executes, and the cleared slot cannot be confirmed afterwards", async () => {
    const { agent, state, said, server } = await armed();

    await expect(userTurn(agent, "yes, go ahead")).resolves.toBeUndefined();
    expect(server.runs).toEqual([]);
    expect(said).toEqual([]);
    expect(state.pending).toBeNull();

    await expect(userTurn(agent, "confirm")).resolves.toBeUndefined();
    expect(server.runs).toEqual([]);
  });

  test("an unrelated turn clears the slot and still absorbs buffered context", async () => {
    const { agent, state, server } = await armed();
    state.contextLines = ["deployment/web in prod: 1/3 ready"];
    const message = new llm.ChatMessage({ role: "user", content: "how many nodes are there" });

    await agent.onUserTurnCompleted(new llm.ChatContext(), message);

    expect(server.runs).toEqual([]);
    expect(state.pending).toBeNull();
    expect(message.textContent).toContain(CONTEXT_HEADING);
  });

  test("a proposal that went stale past the TTL is not executed by a later confirm", async () => {
    const { agent, state, said, server } = await armed();
    state.pending!.armedAt = Date.now() - PENDING_TTL_MS - 1;

    await expect(userTurn(agent, "confirm")).resolves.toBeUndefined();

    expect(server.runs).toEqual([]);
    expect(said).toEqual([]);
    expect(state.pending).toBeNull();
  });

  test("the TTL clock restarts when the readback finishes, not when the tool returned", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const { agent, state, fireSpeechDone, server } = await armed();
    expect(state.pending!.armedAt).toBe(1_000);

    now.mockReturnValue(1_000 + 30_000);
    fireSpeechDone();
    expect(state.pending!.armedAt).toBe(31_000);

    now.mockReturnValue(31_000 + PENDING_TTL_MS);
    await expect(userTurn(agent, "confirm")).rejects.toBeInstanceOf(voice.StopResponse);
    expect(server.runs).toEqual([restart]);
  });

  test("the readback callback never re-arms a slot that was already resolved", async () => {
    const { agent, state, fireSpeechDone } = await armed();
    await expect(userTurn(agent, "cancel")).rejects.toBeInstanceOf(voice.StopResponse);

    fireSpeechDone();

    expect(state.pending).toBeNull();
  });

  test("a non-zero exit is reported as a failure, not as success", async () => {
    const server = fakeServer({
      runAction: async () => ({ code: 1, stdout: "", stderr: 'Error from server: deployments.apps "web" not found' }),
    });
    const { agent, frames, said } = await armed(server);

    await expect(userTurn(agent, "confirm")).rejects.toBeInstanceOf(voice.StopResponse);

    expect(said).toEqual(['That failed: Error from server: deployments.apps "web" not found.']);
    expect(frames[0]!.payload).toMatchObject({ ok: false });
  });

  test("an unreachable server is spoken as a failure with nothing changed", async () => {
    const server = fakeServer({
      runAction: async () => {
        throw new Error("action failed: 503");
      },
    });
    const { agent, frames, said } = await armed(server);

    await expect(userTurn(agent, "confirm")).rejects.toBeInstanceOf(voice.StopResponse);

    expect(said).toEqual(["That failed to reach the app. Nothing was changed."]);
    expect(frames[0]!.payload).toMatchObject({ ok: false });
  });

  test("a confirm with no pending proposal is an ordinary turn", async () => {
    const state = emptySessionState();
    const server = fakeServer();
    const { agent, said } = await startSession(state, server, fakeRoom().room);

    await expect(userTurn(agent, "confirm")).resolves.toBeUndefined();

    expect(server.runs).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe("the live LLM-driven proposal turn", () => {
  test("a model tool call arms the slot, and the real speech handle re-arms it after the readback", async () => {
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
        input: JSON.stringify(
          `Proposed and awaiting a spoken confirmation. Read this command back to the user verbatim: kubectl --context prod rollout restart deployment/web. Then say exactly: ${CONFIRM_PROMPT}`,
        ),
        content: `kubectl --context prod rollout restart deployment/web. ${CONFIRM_PROMPT}`,
        duration: 50,
      },
    ]);

    const result = await session.run({ userInput: "restart web" });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const armedOnReturn = state.pending!.armedAt;

    await vi.waitFor(() => expect(state.pending!.armedAt).toBeGreaterThan(armedOnReturn));
    result.expect.containsFunctionCall({ name: "proposeMutation" });
    expect(frames[0]!.payload.tier).toBe("voice");

    await expect(userTurn(agent, "confirm")).rejects.toBeInstanceOf(voice.StopResponse);
    expect(server.runs).toEqual([restart]);
  }, 20_000);
});
