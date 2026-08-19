// Turns AgentSession's event stream into log lines. Without this the worker
// observes only AgentStateChanged, so a turn that fails anywhere in the
// STT -> LLM -> tools -> TTS pipeline reads as `thinking -> listening` and
// nothing else: no error, no reason, no way to tell a rejected model string
// from a refused tool call from a model that simply had nothing to say.
import { voice } from "@livekit/agents";

export interface DiagnosticLine {
  level: "log" | "error";
  message: string;
}

export type DiagnosticSink = (line: DiagnosticLine) => void;

const MAX_DETAIL = 400;

function truncate(text: string): string {
  return text.length <= MAX_DETAIL ? text : `${text.slice(0, MAX_DETAIL)}...`;
}

/**
 * Pulls the fields an API rejection carries beyond `message`. The inference
 * gateway answers an unusable model id with an HTTP status and a body naming
 * it, and both live on APIError/APIStatusError rather than on Error, so
 * without this a bad `ttsModel` logs as a bare "gateway error".
 */
function apiErrorDetail(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const { statusCode, body } = err as { statusCode?: unknown; body?: unknown };
  const parts: string[] = [];
  if (typeof statusCode === "number") parts.push(`status=${statusCode}`);
  if (body !== null && body !== undefined) parts.push(`body=${truncate(JSON.stringify(body))}`);
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function describeError(error: voice.ErrorEvent["error"] | voice.CloseEvent["error"]): string {
  if (!error) return "";
  if (error.type === "interruption_detection_error") {
    return `${error.type} from ${error.label} recoverable=${error.recoverable}: ${error.message}`;
  }
  return `${error.type} from ${error.label} recoverable=${error.recoverable}: ${error.error.message}${apiErrorDetail(error.error)}`;
}

/**
 * The one line each diagnostic event is worth, or null for the events that
 * carry nothing an operator can act on.
 */
export function describeSessionEvent(ev: voice.AgentEvent): DiagnosticLine | null {
  switch (ev.type) {
    case "error":
      return { level: "error", message: `session error: ${describeError(ev.error)}` };
    case "close": {
      const detail = describeError(ev.error);
      return {
        level: ev.error ? "error" : "log",
        message: `session closed reason=${ev.reason}${detail ? `: ${detail}` : ""}`,
      };
    }
    case "function_tools_executed": {
      const failed = ev.functionCallOutputs.some((out) => out.isError);
      const calls = voice
        .zipFunctionCallsAndOutputs(ev)
        .map(([call, out]) => `${call.name}(${truncate(call.args)}) -> ${out.isError ? "ERROR" : "ok"}: ${truncate(out.output)}`);
      if (calls.length === 0) return null;
      return { level: failed ? "error" : "log", message: `tools executed: ${calls.join(" | ")}` };
    }
    case "conversation_item_added": {
      if (ev.item.type !== "message" || ev.item.role !== "assistant") return null;
      const text = ev.item.textContent ?? "";
      const interrupted = ev.item.interrupted ? " (interrupted)" : "";
      return {
        level: "log",
        message: text ? `assistant said${interrupted}: ${truncate(text)}` : `assistant produced no text${interrupted}`,
      };
    }
    case "speech_created":
      return { level: "log", message: `speech created source=${ev.source} userInitiated=${ev.userInitiated}` };
    case "metrics_collected": {
      const m = ev.metrics;
      if (m.type === "llm_metrics") {
        return {
          level: "log",
          message: `llm metrics: ${m.label} ttft=${Math.round(m.ttftMs)}ms duration=${Math.round(m.durationMs)}ms completionTokens=${m.completionTokens} cancelled=${m.cancelled}`,
        };
      }
      if (m.type === "tts_metrics") {
        return {
          level: "log",
          message: `tts metrics: ${m.label} ttfb=${Math.round(m.ttfbMs)}ms audio=${Math.round(m.audioDurationMs)}ms characters=${m.charactersCount} cancelled=${m.cancelled}`,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function writeToConsole(line: DiagnosticLine): void {
  if (line.level === "error") console.error(line.message);
  else console.log(line.message);
}

/**
 * Subscribes the session events that explain a turn. AgentStateChanged stays
 * with its caller: it drives the desktop's state channel, not diagnostics.
 */
export function attachSessionDiagnostics(session: voice.AgentSession, sink: DiagnosticSink = writeToConsole): void {
  const report = (ev: voice.AgentEvent): void => {
    const line = describeSessionEvent(ev);
    if (line) sink(line);
  };
  session.on(voice.AgentSessionEventTypes.Error, report);
  session.on(voice.AgentSessionEventTypes.Close, report);
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, report);
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, report);
  session.on(voice.AgentSessionEventTypes.SpeechCreated, report);
  session.on(voice.AgentSessionEventTypes.MetricsCollected, report);
}
