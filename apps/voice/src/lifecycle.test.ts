import { describe, expect, test, vi } from "vitest";
import { llm } from "@livekit/agents";
import { AGENT_STATE_TOPIC, announceAgentState, endDesktopSession } from "./lifecycle.js";
import type { PublishRoom } from "./publish.js";
import { DESKTOP_IDENTITY, emptySessionState } from "./state.js";

type PublishData = NonNullable<PublishRoom["localParticipant"]>["publishData"];

function fakeRoom(publishData: PublishData = vi.fn<PublishData>(async () => {})): {
  room: PublishRoom;
  publishData: PublishData;
} {
  return {
    room: {
      localParticipant: { publishData },
      remoteParticipants: new Map([[DESKTOP_IDENTITY, { identity: DESKTOP_IDENTITY }]]),
    },
    publishData,
  };
}

describe("announceAgentState", () => {
  test("sends the state to the desktop on its own topic", async () => {
    const { room, publishData } = fakeRoom();
    await announceAgentState(room, "thinking");

    const [data, options] = vi.mocked(publishData).mock.calls[0]!;
    expect(JSON.parse(new TextDecoder().decode(data))).toEqual({ state: "thinking" });
    expect(options).toEqual({
      reliable: true,
      topic: AGENT_STATE_TOPIC,
      destination_identities: [DESKTOP_IDENTITY],
    });
  });

  test("a failed publish never propagates", async () => {
    const { room } = fakeRoom(
      vi.fn<PublishData>(async () => {
        throw new Error("data channel closed");
      }),
    );
    await expect(announceAgentState(room, "listening")).resolves.toBeUndefined();
  });
});

const fakeAgent = () => ({ updateChatCtx: vi.fn(async () => {}) });
const fakeSession = () => ({ interrupt: vi.fn(() => {}) });

describe("endDesktopSession", () => {
  test("drops proposals outstanding from the last session", async () => {
    const state = emptySessionState();
    state.awaitingClick.set("call-1", "Delete pod web-1");
    await endDesktopSession(state, fakeAgent(), fakeSession());
    expect(state.awaitingClick.size).toBe(0);
  });

  test("stops whatever the agent is saying, so it is not still talking to an empty room", async () => {
    const session = fakeSession();
    await endDesktopSession(emptySessionState(), fakeAgent(), session);
    expect(session.interrupt).toHaveBeenCalled();
  });

  test("an interrupt that throws still clears the session", async () => {
    const state = emptySessionState();
    state.activeContext = "prod";
    const session = {
      interrupt: vi.fn(() => {
        throw new Error("nothing is being said");
      }),
    };
    await endDesktopSession(state, fakeAgent(), session);
    expect(state.activeContext).toBeNull();
  });

  test("drops the spoken context and the cluster keyterms", async () => {
    const state = emptySessionState();
    state.activeContext = "prod";
    state.contextLines = ["deployment web: 1/3 ready"];
    state.keyterms = [...state.keyterms, "reddex"];
    const before = state.keyterms.length;

    await endDesktopSession(state, fakeAgent(), fakeSession());

    expect(state.activeContext).toBeNull();
    expect(state.contextLines).toEqual([]);
    expect(state.keyterms).not.toContain("reddex");
    expect(state.keyterms.length).toBeLessThan(before);
  });

  test("mutates the shared state object rather than replacing it", async () => {
    const state = emptySessionState();
    const contextLines = state.contextLines;
    contextLines.push("deployment web: 1/3 ready");
    await endDesktopSession(state, fakeAgent(), fakeSession());
    expect(state.contextLines).toEqual([]);
    expect(state.contextLines).not.toBe(contextLines);
  });

  test("empties the agent's chat history", async () => {
    const updateChatCtx = vi.fn(async (_chatCtx: llm.ChatContext) => {});
    await endDesktopSession(emptySessionState(), { updateChatCtx }, fakeSession());
    expect(updateChatCtx).toHaveBeenCalledTimes(1);
    expect(updateChatCtx.mock.calls[0]![0].items).toEqual([]);
  });
});
