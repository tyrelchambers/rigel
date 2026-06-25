import type { RuntimeConfig } from "./runtimeConfig.js";
import { claudeBridge } from "./providers/claude.js";
import { codexBridge } from "./providers/codex.js";
import { geminiBridge } from "./providers/gemini.js";
import { opencodeBridge } from "./providers/opencode.js";
import { errorResult, type ProviderBridge, type ProviderId, type ProviderResult, type Role } from "./providers/types.js";

/** The provider bridges, by id. */
const BRIDGES: Record<ProviderId, ProviderBridge> = {
  claude: claudeBridge,
  codex: codexBridge,
  gemini: geminiBridge,
  opencode: opencodeBridge,
};

export interface RunModelOptions {
  /** Which role's selection to use. */
  role: Role;
  /** The live runtime config (already read this tick — runModel does NOT re-read). */
  config: RuntimeConfig;
  prompt: string;
  systemPrompt?: string;
  /** Read-only kubectl allowlist (Claude's --allowedTools; others use the shim). */
  allowedReads?: string[];
  /** Request structured JSON shaped by this JSON-Schema string. */
  structuredSchema?: string;
  /** Accept/reject the structuredOutput; required when structuredSchema is set.
   *  Returns true when the parsed verdict is acceptable. */
  validateStructured?: (output: unknown) => boolean;
  resumeSessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Single model-dispatch entry point. Reads the role's {provider, model, effort}
 * from the live config, selects the bridge, fails closed if no credential, and runs
 * one turn — returning the normalized ProviderResult. For a STRUCTURED turn on a
 * non-Claude provider (which has no --json-schema), it validates the parsed output
 * and REPROMPTS ONCE on failure; a second failure fails closed (the supervisor maps
 * that to "escalate" — never auto-approve on a bad verdict). Claude's structured
 * output is schema-validated by the CLI, so it passes straight through.
 */
export async function runModel(opts: RunModelOptions): Promise<ProviderResult> {
  const selection = opts.role === "worker" ? opts.config.worker : opts.config.supervisor;
  const bridge = BRIDGES[selection.provider];
  if (!bridge) return errorResult(`Unknown provider "${selection.provider}" for the ${opts.role} role.`);

  if (!bridge.authEnv()) {
    return errorResult(
      `${opts.role} provider ${selection.provider} has no credential — add a key for it.`,
    );
  }

  const base = {
    model: selection.model,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    allowedReads: opts.allowedReads,
    structuredSchema: opts.structuredSchema,
    effort: selection.effort,
    resumeSessionId: opts.resumeSessionId,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  };

  const first = await bridge.run(base);
  if (first.isError) return first;

  // No structured contract → return as-is.
  if (!opts.structuredSchema || !opts.validateStructured) return first;

  // Claude validates against the schema in-CLI; trust its structuredOutput.
  if (selection.provider === "claude") {
    if (first.structuredOutput !== undefined && opts.validateStructured(first.structuredOutput)) return first;
    return errorResult("Claude returned no valid structured verdict.");
  }

  // Non-Claude: validate the parsed JSON; reprompt ONCE on failure.
  if (first.structuredOutput !== undefined && opts.validateStructured(first.structuredOutput)) return first;

  const reprompt = await bridge.run({
    ...base,
    prompt: `${opts.prompt}\n\nYour previous reply was not a single valid JSON object matching the schema. Reply again with ONLY the JSON object — no prose, no fences.`,
  });
  if (reprompt.isError) return reprompt;
  if (reprompt.structuredOutput !== undefined && opts.validateStructured(reprompt.structuredOutput)) {
    return reprompt;
  }
  return errorResult("Provider did not return a valid structured verdict after one reprompt (fail-closed).");
}
