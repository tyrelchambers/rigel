import { APIStatusError, llm, voice } from "@livekit/agents";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { attachSessionDiagnostics, describeSessionEvent, type DiagnosticLine } from "./diagnostics.js";

function ttsError(error: Error): voice.ErrorEvent {
  return {
    type: "error",
    error: { type: "tts_error", timestamp: Date.now(), label: "inference.TTS", error, recoverable: false },
    createdAt: Date.now(),
  };
}

describe("describeSessionEvent", () => {
  test("an unusable tts model id logs the status and the gateway's body", () => {
    const line = describeSessionEvent(
      ttsError(
        new APIStatusError({
          message: "gateway rejected the request",
          options: { statusCode: 400, body: { error: "unknown model xai/tts-1:ara" } },
        }),
      ),
    );
    expect(line?.level).toBe("error");
    expect(line?.message).toContain("tts_error from inference.TTS");
    expect(line?.message).toContain("recoverable=false");
    expect(line?.message).toContain("gateway rejected the request");
    expect(line?.message).toContain("status=400");
    expect(line?.message).toContain('body={"error":"unknown model xai/tts-1:ara"}');
  });

  test("a plain error still logs its message", () => {
    const line = describeSessionEvent(ttsError(new Error("socket hang up")));
    expect(line?.message).toContain("socket hang up");
    expect(line?.message).not.toContain("status=");
  });

  test("a close carrying an error is an error line naming the reason", () => {
    const line = describeSessionEvent({
      type: "close",
      reason: voice.CloseReason.ERROR,
      error: { type: "llm_error", timestamp: 0, label: "openai.LLM", error: new Error("401"), recoverable: false },
      createdAt: 0,
    });
    expect(line).toEqual({
      level: "error",
      message: "session closed reason=error: llm_error from openai.LLM recoverable=false: 401",
    });
  });

  test("a clean close is not an error", () => {
    const line = describeSessionEvent({
      type: "close",
      reason: voice.CloseReason.USER_INITIATED,
      error: null,
      createdAt: 0,
    });
    expect(line).toEqual({ level: "log", message: "session closed reason=user_initiated" });
  });

  test("a failed tool call is an error line carrying the tool output", () => {
    const line = describeSessionEvent({
      type: "function_tools_executed",
      functionCalls: [llm.FunctionCall.create({ callId: "c1", name: "readCluster", args: '{"verb":"get"}' })],
      functionCallOutputs: [llm.FunctionCallOutput.create({ callId: "c1", output: "context not found", isError: true })],
      createdAt: 0,
    });
    expect(line?.level).toBe("error");
    expect(line?.message).toContain("readCluster");
    expect(line?.message).toContain("ERROR");
    expect(line?.message).toContain("context not found");
  });

  test("a successful tool call is a log line", () => {
    const line = describeSessionEvent({
      type: "function_tools_executed",
      functionCalls: [llm.FunctionCall.create({ callId: "c1", name: "readCluster", args: "{}" })],
      functionCallOutputs: [llm.FunctionCallOutput.create({ callId: "c1", output: "3 pods", isError: false })],
      createdAt: 0,
    });
    expect(line).toEqual({ level: "log", message: "tools executed: readCluster({}) -> ok: 3 pods" });
  });

  test("an assistant turn that produced no text says so", () => {
    const line = describeSessionEvent({
      type: "conversation_item_added",
      item: llm.ChatMessage.create({ role: "assistant", content: "" }),
      createdAt: 0,
    });
    expect(line).toEqual({ level: "log", message: "assistant produced no text" });
  });

  test("an assistant turn logs what it said", () => {
    const line = describeSessionEvent({
      type: "conversation_item_added",
      item: llm.ChatMessage.create({ role: "assistant", content: "reddex has three pods" }),
      createdAt: 0,
    });
    expect(line?.message).toBe("assistant said: reddex has three pods");
  });

  test("user transcripts are left to the SDK's own logging", () => {
    const line = describeSessionEvent({
      type: "conversation_item_added",
      item: llm.ChatMessage.create({ role: "user", content: "how is reddex doing" }),
      createdAt: 0,
    });
    expect(line).toBeNull();
  });

  test("long tool output is truncated", () => {
    const line = describeSessionEvent({
      type: "function_tools_executed",
      functionCalls: [llm.FunctionCall.create({ callId: "c1", name: "readCluster", args: "{}" })],
      functionCallOutputs: [llm.FunctionCallOutput.create({ callId: "c1", output: "x".repeat(5000), isError: false })],
      createdAt: 0,
    });
    expect(line?.message.length).toBeLessThan(600);
    expect(line?.message).toContain("...");
  });

  test("llm and tts metrics report timings, vad metrics are dropped", () => {
    const llmLine = describeSessionEvent({
      type: "metrics_collected",
      metrics: {
        type: "llm_metrics",
        label: "openai.LLM",
        requestId: "r1",
        timestamp: 0,
        durationMs: 900.4,
        ttftMs: 320.6,
        cancelled: false,
        completionTokens: 12,
        promptTokens: 100,
        promptCachedTokens: 0,
        totalTokens: 112,
        tokensPerSecond: 13,
      },
      createdAt: 0,
    });
    expect(llmLine?.message).toBe("llm metrics: openai.LLM ttft=321ms duration=900ms completionTokens=12 cancelled=false");

    const vadLine = describeSessionEvent({
      type: "metrics_collected",
      metrics: {
        type: "vad_metrics",
        label: "silero.VAD",
        timestamp: 0,
        idleTimeMs: 10,
        inferenceDurationTotalMs: 1,
        inferenceCount: 2,
      },
      createdAt: 0,
    });
    expect(vadLine).toBeNull();
  });
});

describe("attachSessionDiagnostics", () => {
  test("reports errors, closes, tool calls, assistant turns, speech and metrics", () => {
    const session = new EventEmitter() as unknown as voice.AgentSession;
    const lines: DiagnosticLine[] = [];
    attachSessionDiagnostics(session, (line) => lines.push(line));

    const emitter = session as unknown as EventEmitter;
    emitter.emit(voice.AgentSessionEventTypes.Error, ttsError(new Error("boom")));
    emitter.emit(voice.AgentSessionEventTypes.SpeechCreated, {
      type: "speech_created",
      userInitiated: false,
      source: "generate_reply",
      speechHandle: {} as voice.SpeechCreatedEvent["speechHandle"],
      createdAt: 0,
    } satisfies voice.SpeechCreatedEvent);
    emitter.emit(voice.AgentSessionEventTypes.Close, {
      type: "close",
      reason: voice.CloseReason.ERROR,
      error: null,
      createdAt: 0,
    } satisfies voice.CloseEvent);

    expect(lines.map((l) => l.message)).toEqual([
      "session error: tts_error from inference.TTS recoverable=false: boom",
      "speech created source=generate_reply userInitiated=false",
      "session closed reason=error",
    ]);
  });

  test("agent state changes stay with their own subscriber", () => {
    const session = new EventEmitter() as unknown as voice.AgentSession;
    const lines: DiagnosticLine[] = [];
    attachSessionDiagnostics(session, (line) => lines.push(line));
    (session as unknown as EventEmitter).emit(voice.AgentSessionEventTypes.AgentStateChanged, {
      type: "agent_state_changed",
      oldState: "listening",
      newState: "thinking",
      createdAt: 0,
    } satisfies voice.AgentStateChangedEvent);
    expect(lines).toEqual([]);
  });
});
