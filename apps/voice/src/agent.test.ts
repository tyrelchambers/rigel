import { llm } from "@livekit/agents";
import { describe, expect, test } from "vitest";
import { buildAgent, CONTEXT_HEADING } from "./agent.js";
import { emptySessionState } from "./state.js";

function readCluster(agent: ReturnType<typeof buildAgent>) {
  const tool = agent.toolCtx.getFunctionTool("readCluster");
  if (!tool) throw new Error("readCluster is not registered");
  return (args: Record<string, unknown>) => tool.execute(args, {} as never) as Promise<string>;
}

describe("buildAgent", () => {
  test("exposes readCluster with a closed verb set", () => {
    const tool = buildAgent(emptySessionState()).toolCtx.getFunctionTool("readCluster");
    const shape = (tool?.parameters as { shape: { verb: { options: string[] } } }).shape;
    expect(shape.verb.options).toEqual(["get", "describe", "logs", "top", "events"]);
  });

  test("the instructions name the active context the session was built with", () => {
    const state = emptySessionState();
    state.activeContext = "kind-rigel";
    expect(buildAgent(state).instructions).toContain("kind-rigel");
  });

  test("a read the builder rejects comes back as text, not a thrown tool call", async () => {
    const call = readCluster(buildAgent(emptySessionState()));
    await expect(call({ verb: "describe", kind: "pod" })).resolves.toMatch(/describe needs kind and name/);
  });

  test("a completed user turn absorbs the buffered context lines exactly once", async () => {
    const state = emptySessionState();
    state.contextLines = ["deployment/web in prod: 1/3 ready", "pod/web-7 in prod: CrashLoopBackOff"];
    const agent = buildAgent(state);
    const message = new llm.ChatMessage({ role: "user", content: "what is wrong with web" });

    await agent.onUserTurnCompleted(new llm.ChatContext(), message);
    expect(message.textContent).toContain("what is wrong with web");
    expect(message.textContent).toContain(`${CONTEXT_HEADING}\ndeployment/web in prod: 1/3 ready`);
    expect(state.contextLines).toEqual([]);

    await agent.onUserTurnCompleted(new llm.ChatContext(), message);
    expect(message.content).toHaveLength(2);
  });

  test("a turn with no buffered context is left alone", async () => {
    const agent = buildAgent(emptySessionState());
    const message = new llm.ChatMessage({ role: "user", content: "how many nodes" });
    await agent.onUserTurnCompleted(new llm.ChatContext(), message);
    expect(message.content).toEqual(["how many nodes"]);
  });
});
