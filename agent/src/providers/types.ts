import type { CommandVerdict } from "../commandPolicy.js";

export type { CommandVerdict };

/** The provider this role uses. Mirrors the chat's AgentId. */
export type ProviderId = "claude" | "codex" | "gemini" | "opencode";

/** Which role we are running the model for. */
export type Role = "worker" | "supervisor";

/** Per-role selection, parsed from the assistant-config ConfigMap. */
export interface RoleSelection {
  provider: ProviderId;
  model: string;
  /** Claude-family only; ignored by other providers. */
  effort?: string;
}

/**
 * The single normalized result EVERY bridge returns and runModel passes back.
 * Superset of the legacy ClaudeResult so worker/supervisor/diagnose keep working.
 * A bridge NEVER throws for an expected failure (missing cred, absent CLI, bad
 * exit, malformed structured output) — it returns { isError: true, errorMessage }
 * so the caller fails closed deterministically.
 */
export interface ProviderResult {
  /** Final assistant prose. "" on error. */
  text: string;
  /** USD cost when the CLI reports it (Claude only today); 0 otherwise. */
  costUsd: number;
  /** True if the call failed OR the provider returned an error result. */
  isError: boolean;
  /** Human-readable failure detail when isError; undefined on success. */
  errorMessage?: string;
  /** CLI session id to resume the thread (Claude only); undefined otherwise. */
  sessionId?: string;
  /** Validated/parsed structured output when a structuredSchema was requested. */
  structuredOutput?: unknown;
}

/** Input to a single model turn — provider-agnostic. */
export interface RunModelInput {
  /** Final model id to launch (already resolved from the role selection). */
  model: string;
  /** The user/task prompt. */
  prompt: string;
  /** Appended system prompt / instructions. */
  systemPrompt?: string;
  /** Read-only kubectl allowlist for the Claude bridge's --allowedTools. The
   *  other bridges enforce read-only via the guarded-kubectl shim instead. */
  allowedReads?: string[];
  /** When set, request structured JSON matching this JSON-Schema string. */
  structuredSchema?: string;
  /** Claude-family reasoning effort; ignored by other providers. */
  effort?: string;
  /** Prior CLI session id (Claude resumes; others run fresh per turn). */
  resumeSessionId?: string;
  /** Abort the in-flight subprocess. */
  signal?: AbortSignal;
  /** Per-turn wall-clock cap in ms. */
  timeoutMs?: number;
}

/**
 * One provider bridge. `authEnv()` returns the env vars that authenticate this
 * provider, or null when no credential is present (→ runModel fails closed with a
 * clear "add a key" message). `run()` performs one turn and ALWAYS resolves to a
 * ProviderResult (never throws for expected failures).
 */
export interface ProviderBridge {
  id: ProviderId;
  /** Env vars from process.env to authenticate, or null if no credential set. */
  authEnv(): Record<string, string> | null;
  /** Run one turn. Resolves (never rejects) to a normalized result. */
  run(input: RunModelInput): Promise<ProviderResult>;
}

/** Build a fail-closed error result carrying a message. */
export function errorResult(message: string): ProviderResult {
  return { text: "", costUsd: 0, isError: true, errorMessage: message };
}
