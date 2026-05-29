import { spawn } from "node:child_process";

/**
 * Wrapper around `claude -p --output-format json`. Authenticates via the
 * subscription using the CLAUDE_CODE_OAUTH_TOKEN env var (set from a k8s Secret
 * minted with `claude setup-token`). NEVER passes `--bare` — bare mode skips
 * OAuth and would demand an API key.
 */

export interface ClaudeResult {
  text: string;
  costUsd: number;
  isError: boolean;
  /** Present when the call used --json-schema (the validated structured output). */
  structuredOutput?: unknown;
}

/** Parse the single JSON envelope `claude -p --output-format json` prints.
 * Tolerates leading noise by scanning for the first balanced JSON object. */
export function parseClaudeResult(stdout: string): ClaudeResult {
  const obj = extractJsonObject(stdout);
  return {
    text: typeof obj.result === "string" ? obj.result : "",
    costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
    isError: obj.is_error === true,
    structuredOutput: "structured_output" in obj ? obj.structured_output : undefined,
  };
}

function extractJsonObject(stdout: string): Record<string, any> {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as Record<string, any>;
  } catch {
    // Fall back to the substring from the first "{" to the last "}".
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("claude output was not valid JSON");
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, any>;
  }
}

export interface RunClaudeOptions {
  model: string;
  prompt: string;
  /** Read-only tool allowlist passed via repeated --allowedTools flags. */
  allowedTools?: string[];
  appendSystemPrompt?: string;
  /** JSON Schema string for --json-schema (structured output). */
  jsonSchema?: string;
  cwd?: string;
  timeoutMs?: number;
}

/** Invoke claude non-interactively and return the parsed envelope. Rejects on a
 * non-zero exit, a timeout, or an error envelope — callers treat any failure as
 * fail-closed (do not act). */
export async function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  const args = ["-p", opts.prompt, "--model", opts.model, "--output-format", "json"];
  for (const tool of opts.allowedTools ?? []) args.push("--allowedTools", tool);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.jsonSchema) args.push("--json-schema", opts.jsonSchema);

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`claude timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${err.trim()}`));
      else resolve(out);
    });
  });

  const result = parseClaudeResult(stdout);
  if (result.isError) throw new Error(`claude returned an error result: ${result.text}`);
  return result;
}
