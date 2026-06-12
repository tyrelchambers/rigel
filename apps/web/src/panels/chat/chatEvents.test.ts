import { describe, it, expect } from "vitest";
import { appendTextDelta, stampThinking, elapsedSeconds, makeMessage } from "./chatLogic";
import type { ChatEvent, ChatMessage } from "./types";

/**
 * Reducer mirroring ChatPanel.handleChatEvent so the streaming state machine
 * can be tested without React. Accumulates thinking/text deltas, stamps
 * thinking at "done", and turns "error" into a terminal system message.
 */
interface TurnState {
  messages: ChatMessage[];
  liveThinking: string;
  isStreaming: boolean;
  isThinking: boolean;
  turnStartedAt: Date | null;
}

function reduce(state: TurnState, event: ChatEvent): TurnState {
  switch (event.type) {
    case "thinking":
      return {
        ...state,
        liveThinking: state.liveThinking + event.text,
        isThinking: true,
      };
    case "text":
      return { ...state, messages: appendTextDelta(state.messages, event.text) };
    case "done": {
      const secs = state.turnStartedAt ? elapsedSeconds(state.turnStartedAt) : 0;
      return {
        ...state,
        messages: stampThinking(state.messages, state.liveThinking, secs),
        isStreaming: false,
        isThinking: false,
        liveThinking: "",
      };
    }
    case "error":
      return {
        ...state,
        messages: [...state.messages, makeMessage("system", `⚠︎ ${event.text}`)],
        isStreaming: false,
        isThinking: false,
        liveThinking: "",
      };
    default:
      return state;
  }
}

function initial(): TurnState {
  return {
    messages: [],
    liveThinking: "",
    isStreaming: true,
    isThinking: false,
    turnStartedAt: new Date(Date.now() - 4000),
  };
}

describe("chat event stream", () => {
  it("accumulates thinking, and joins separate text blocks with a blank line", () => {
    let s = initial();
    const events: ChatEvent[] = [
      // thinking deltas concatenate raw…
      { type: "thinking", text: "Let me analyze" },
      { type: "thinking", text: " the pods" },
      // …while each text event is a COMPLETE block → separated by a blank line.
      { type: "text", text: "Looking now." },
      { type: "text", text: "Here are the pods." },
    ];
    for (const e of events) s = reduce(s, e);
    expect(s.liveThinking).toBe("Let me analyze the pods");
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe("assistant");
    expect(s.messages[0].text).toBe("Looking now.\n\nHere are the pods.");
    expect(s.isStreaming).toBe(true);
  });

  it("stamps thinking and ends streaming on done", () => {
    let s = initial();
    for (const e of [
      { type: "thinking", text: "reasoning" } as ChatEvent,
      { type: "text", text: "answer" } as ChatEvent,
      { type: "done" } as ChatEvent,
    ]) {
      s = reduce(s, e);
    }
    expect(s.isStreaming).toBe(false);
    expect(s.isThinking).toBe(false);
    expect(s.liveThinking).toBe("");
    expect(s.messages[0].thinking).toBe("reasoning");
    expect(s.messages[0].thinkingSeconds).toBeGreaterThanOrEqual(3);
  });

  it("does not stamp a thinking trail when none arrived", () => {
    let s = initial();
    for (const e of [
      { type: "text", text: "plain answer" } as ChatEvent,
      { type: "done" } as ChatEvent,
    ]) {
      s = reduce(s, e);
    }
    expect(s.messages[0].thinking).toBeUndefined();
  });

  it("turns error into a terminal system message and stops streaming", () => {
    let s = initial();
    s = reduce(s, { type: "error", text: "claude exited with code 1" });
    expect(s.isStreaming).toBe(false);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe("system");
    expect(s.messages[0].text).toContain("claude exited with code 1");
  });
});
