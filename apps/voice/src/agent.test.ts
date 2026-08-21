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
  runs: SuggestedAction[];
  proposals: SuggestedAction[];
}

const LINK = {
  source: "shop-web-82b3ade",
  repo: "owner/repo",
  repoName: "owner-repo",
  repoURL: "https://github.com/owner/repo",
  branch: "main",
  path: "k8s",
};

function fakeServer(overrides: Partial<ServerClient> = {}): FakeServer {
  const previews: SuggestedAction[] = [];
  const runs: SuggestedAction[] = [];
  const proposals: SuggestedAction[] = [];
  return {
    previews,
    runs,
    proposals,
    repoLink: async () => ({ linked: true, link: LINK }),
    proposeFix: async (action) => {
      proposals.push(action);
      return { ok: true, prUrl: "https://github.com/owner/repo/pull/7", number: 7, branch: "rigel/fix-x", message: "ok" };
    },
    agentConfig: async () => {
      throw new Error("not used");
    },
    previewAction: async (action) => {
      previews.push(action);
      return ["kubectl", "--context", "prod", "rollout", "restart", "deployment/web"];
    },
    runAction: async (action) => {
      runs.push(action);
      return { code: 0, stdout: "restarted", stderr: "" };
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
  test("a non-destructive change the operator asked for is run, and reported as run", async () => {
    const state = emptySessionState();
    state.activeContext = "prod";
    const server = fakeServer();
    const { room, frames } = fakeRoom();
    const { opts } = toolOpts("call-42");

    const out = await propose(buildAgent(state, server, room), restart, opts);

    expect(server.previews).toEqual([restart]);
    expect(server.runs).toEqual([restart]);
    expect(out).toMatch(/^Done:/);
    // Nothing was left waiting on the desktop, because nothing is waiting.
    expect(state.awaitingClick.size).toBe(0);
    expect(frames).toEqual([
      {
        topic: "rigel.action",
        payload: {
          id: "call-42",
          action: restart,
          command: "kubectl --context prod rollout restart deployment/web",
          auto: true,
        },
      },
      { topic: "rigel.action.result", payload: { id: "call-42", ok: true, summary: "ran" } },
    ]);
  });

  test("a failed run is reported as failed, with the cluster's own first line", async () => {
    const server = fakeServer({
      runAction: async () => ({ code: 1, stdout: "", stderr: 'Error from server: deployments.apps "web" not found' }),
    });
    const { room, frames } = fakeRoom();

    const out = await propose(buildAgent(emptySessionState(), server, room), restart, toolOpts().opts);

    expect(out).toMatch(/^That failed: Error from server/);
    expect(frames[1]!.payload).toMatchObject({ ok: false });
  });

  test("a run that cannot reach the app says nothing changed", async () => {
    const server = fakeServer({
      runAction: async () => {
        throw new Error("socket hang up");
      },
    });
    const { room, frames } = fakeRoom();

    const out = await propose(buildAgent(emptySessionState(), server, room), restart, toolOpts().opts);

    expect(out).toMatch(/nothing changed/);
    expect(frames[1]!.payload).toMatchObject({ ok: false });
  });

  test("a destructive kind is never run, only surfaced", async () => {
    const state = emptySessionState();
    const server = fakeServer();
    const { room, frames } = fakeRoom();
    const del: SuggestedAction = { kind: "deleteResource", label: "Delete svc web", name: "web", resourceKind: "service" };

    const out = await propose(buildAgent(state, server, room), del, toolOpts("call-9").opts);

    expect(server.runs).toEqual([]);
    expect(out).toBe(SENT_TO_DESKTOP);
    expect(state.awaitingClick.get("call-9")).toBe(del.label);
    expect(frames.map((f) => f.topic)).toEqual(["rigel.action"]);
    expect(frames[0]!.payload.auto).toBeUndefined();
  });

  test("an irreversible kind waits on the desktop and is remembered for its result", async () => {
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

    for (const kind of ["purge", "applyManifest"]) {
      await expect(propose(agent, { kind, label: kind }, toolOpts().opts)).resolves.toMatch(/desktop/);
    }
    // proposeRepoFix opens the PR itself unless a destructive hint downgrades
    // it; downgraded, it is as unpreviewable as the other two.
    await expect(
      propose(agent, { kind: "proposeRepoFix", label: "pr", destructive: true }, toolOpts().opts),
    ).resolves.toMatch(/desktop/);
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

describe("the live LLM-driven turn", () => {
  test("a model tool call runs the change, and nothing spoken afterwards runs anything else", async () => {
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
          "Done: kubectl --context prod rollout restart deployment/web ran and completed. Tell the user in one short sentence what changed.",
        ),
        content: "Restarted web.",
        duration: 50,
      },
    ]);

    const result = await session.run({ userInput: "restart web" });
    await vi.waitFor(() => expect(frames).toHaveLength(2));

    result.expect.containsFunctionCall({ name: "proposeMutation" });
    expect(frames[0]!.payload).toMatchObject({ action: restart, auto: true });
    expect(frames[1]!.topic).toBe("rigel.action.result");
    expect(server.runs).toEqual([restart]);

    // The word that used to execute is now an ordinary turn. It reaches
    // nothing, because the only path to runAction is a tool call the model
    // makes on an explicit instruction.
    await expect(userTurn(agent, "confirm")).resolves.toBeUndefined();
    expect(server.runs).toEqual([restart]);
  }, 20_000);
});

describe("checkGitLink", () => {
  const ask = (agent: voice.Agent, args: unknown) =>
    agent.toolCtx.getFunctionTool("checkGitLink")!.execute(args as never, {} as never) as Promise<string>;

  test("says which repository a linked workload is managed from", async () => {
    const out = await ask(buildAgent(emptySessionState(), fakeServer(), fakeRoom().room), {
      name: "web",
      namespace: "shop",
    });
    expect(out).toContain("owner/repo");
    expect(out).toContain(LINK.source);
    expect(out).toContain("main");
  });

  test("passes the workload's kind through, so a statefulset resolves too", async () => {
    const asked: unknown[] = [];
    const server = fakeServer({
      repoLink: async (workload) => {
        asked.push(workload);
        return { linked: true, link: LINK };
      },
    });
    await ask(buildAgent(emptySessionState(), server, fakeRoom().room), {
      kind: "statefulset",
      name: "web",
      namespace: "shop",
    });
    expect(asked).toEqual([{ kind: "statefulset", name: "web", namespace: "shop" }]);
  });

  test("an unlinked workload is stated plainly, not as an error", async () => {
    const server = fakeServer({ repoLink: async () => ({ linked: false, link: null }) });
    const out = await ask(buildAgent(emptySessionState(), server, fakeRoom().room), { name: "web" });
    expect(out).toMatch(/not/i);
    expect(out).toContain("pull request");
  });

  test("a server that cannot answer comes back as text, not a thrown tool call", async () => {
    const server = fakeServer({
      repoLink: async () => {
        throw new Error("socket hang up");
      },
    });
    await expect(ask(buildAgent(emptySessionState(), server, fakeRoom().room), { name: "web" })).resolves.toContain(
      "socket hang up",
    );
  });
});

describe("proposeRepoFix from voice", () => {
  const fix: SuggestedAction = {
    kind: "proposeRepoFix",
    label: "Open a PR annotating web",
    source: "shop-web-82b3ade",
    title: "Annotate web",
    body: "asked for over voice",
    name: "web",
    namespace: "shop",
    edit: { op: "annotate", annotations: { "example.com/owner": "platform" } },
  };

  test("opens the pull request itself and speaks the number and the URL", async () => {
    const state = emptySessionState();
    const server = fakeServer();
    const { room, frames } = fakeRoom();

    const out = await propose(buildAgent(state, server, room), fix, toolOpts("call-7").opts);

    expect(server.proposals).toEqual([fix]);
    expect(server.previews).toEqual([]); // a PR is not a kubectl command
    expect(out).toContain("7");
    expect(out).toContain("https://github.com/owner/repo/pull/7");
    expect(out).toMatch(/nothing was changed on the cluster/i);
    expect(state.awaitingClick.size).toBe(0);
    expect(frames).toEqual([
      { topic: "rigel.action", payload: { id: "call-7", action: fix, command: null, auto: true } },
      {
        topic: "rigel.action.result",
        payload: { id: "call-7", ok: true, summary: "opened pull request #7", prUrl: "https://github.com/owner/repo/pull/7" },
      },
    ]);
  });

  test("carries no diff on the wire, because the pull request shows the change", async () => {
    const { room, frames } = fakeRoom();
    await propose(buildAgent(emptySessionState(), fakeServer(), room), fix, toolOpts().opts);
    expect(JSON.stringify(frames)).not.toContain("diff");
  });

  test("opens the pull request even with no desktop connected", async () => {
    const server = fakeServer();
    const { room, frames } = fakeRoom(["phone-1"]);
    const out = await propose(buildAgent(emptySessionState(), server, room), fix, toolOpts().opts);
    expect(server.proposals).toEqual([fix]);
    expect(out).toMatch(/^Done:/);
    // The frames are display only, so they go up regardless; nothing waits.
    expect(frames.map((f) => f.topic)).toEqual(["rigel.action", "rigel.action.result"]);
  });

  test("a refusal from the server is spoken as its own reason, and never as an open PR", async () => {
    const server = fakeServer({
      proposeFix: async () => ({ ok: false, message: "No manifest under k8s defines deployment web in namespace shop." }),
    });
    const { room, frames } = fakeRoom();

    const out = await propose(buildAgent(emptySessionState(), server, room), fix, toolOpts().opts);

    expect(out).toContain("No manifest under k8s");
    expect(out).not.toMatch(/^Done:/);
    expect(frames[1]!.payload).toMatchObject({ ok: false });
  });

  test("a server it cannot reach says nothing was pushed", async () => {
    const server = fakeServer({
      proposeFix: async () => {
        throw new Error("unknown source");
      },
    });
    const { room, frames } = fakeRoom();

    const out = await propose(buildAgent(emptySessionState(), server, room), fix, toolOpts().opts);

    expect(out).toContain("unknown source");
    expect(out).toMatch(/nothing was pushed/i);
    expect(frames[1]!.payload).toMatchObject({ ok: false });
  });

  test("a proposal missing what a pull request needs is refused with the shape to retry with", async () => {
    const server = fakeServer();
    const { room, frames } = fakeRoom();
    const agent = buildAgent(emptySessionState(), server, room);

    const out = await propose(agent, { kind: "proposeRepoFix", label: "Open a PR" }, toolOpts().opts);

    expect(out).toMatch(/^Refused:/);
    expect(out).toContain("checkGitLink");
    expect(out).toContain("edit");
    expect(server.proposals).toEqual([]);
    expect(frames).toEqual([]);
  });

  test("a destructive hint downgrades it to the desktop, where the sheet takes over", async () => {
    const state = emptySessionState();
    const server = fakeServer();
    const { room, frames } = fakeRoom();

    const out = await propose(buildAgent(state, server, room), { ...fix, destructive: true }, toolOpts("call-3").opts);

    expect(server.proposals).toEqual([]);
    expect(out).toBe(SENT_TO_DESKTOP);
    expect(state.awaitingClick.get("call-3")).toBe(fix.label);
    expect(frames[0]!.payload.command).toBeNull();
  });
});
