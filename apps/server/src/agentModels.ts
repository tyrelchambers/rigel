// Per-agent model + effort lists, for the composer's agent-aware model picker.
//
// The web composer asks the server "what models can THIS agent run?" and renders
// a picker from the result. claude/codex are static sets; opencode is discovered
// live via `opencode models`. Effort is a Claude-only concept (the others return
// an empty efforts list), mirroring the runner wiring in claudeBridge/codexBridge/
// opencodeBridge.
import { spawn } from "node:child_process";
import { ALLOWED_MODELS } from "./claudeBridge";
import type { AgentId } from "./agentRegistry";

export interface AgentModels {
  /** Selectable model ids for this agent (may be empty if none are known). */
  models: string[];
  /** Selectable reasoning-effort levels (Claude-only; empty for the others). */
  efforts: string[];
}

/**
 * Codex model list. CURATED: the `codex` CLI has no "list models" command (verified
 * against codex-cli 0.141 — `codex models` is treated as a prompt, not a subcommand;
 * it only takes `-m`/`--model`), so this is a hand-maintained set of the current
 * Codex-runnable models. Update when OpenAI ships new ones. No efforts (Codex doesn't
 * take a reasoning-effort flag).
 */
const CODEX_MODELS = ["gpt-5-codex", "gpt-5.4", "gpt-5"];

/**
 * Gemini model list. CURATED: gemini-cli has no "list models" command (verified
 * against gemini 0.27 — only `-m`/`--model`), so this is a hand-maintained set of
 * the current Gemini models (the 3.x line, then the prior 2.5 line). Update when
 * Google ships new ones. Effort is Claude-only, so the efforts list is empty.
 */
const GEMINI_MODELS = ["gemini-3-pro", "gemini-3-flash", "gemini-2.5-pro", "gemini-2.5-flash"];

/**
 * Parse the stdout of `opencode models` into a deduped, sorted list of model ids.
 * Pure + exported so it's unit-testable without spawning opencode.
 *
 * `opencode models` prints one `provider/model` per line (it only lists — no model
 * call, no cost). We keep lines that look like a single-slash `provider/model` with
 * no whitespace, dropping blank lines, headers, and any other junk.
 */
export function parseOpencodeModels(stdout: string): string[] {
  const seen = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Exactly one "/" and no internal whitespace ⇒ looks like provider/model.
    if (/\s/.test(line)) continue;
    if (line.split("/").length !== 2) continue;
    const [provider, model] = line.split("/");
    if (!provider || !model) continue;
    seen.add(line);
  }
  return [...seen].sort();
}

/**
 * Parse the reasoning-effort levels out of `claude --help`. The `--effort` line
 * documents its accepted values as a parenthesised list (e.g. `(low, medium, high,
 * xhigh, max)`), which may wrap onto the next line; we grab the first parenthesised
 * group after `--effort` and keep the lowercase tokens, order preserved. Pure +
 * exported so it's unit-testable without spawning claude. [] if nothing matches.
 */
export function parseClaudeEfforts(helpText: string): string[] {
  const group = helpText.match(/--effort[\s\S]*?\(([^)]+)\)/);
  if (!group) return [];
  const seen = new Set<string>();
  for (const raw of group[1].split(",")) {
    const tok = raw.trim();
    if (/^[a-z]+$/.test(tok)) seen.add(tok);
  }
  return [...seen];
}

/**
 * Spawn a short-lived listing/help command and return its full stdout. Returns ""
 * (never throws) if the spawn fails — e.g. the binary isn't installed. Kills the
 * process after a modest timeout so a hang can't block the picker request.
 */
function captureCliStdout(cmd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(""); // spawn threw synchronously (rare)
      return;
    }

    proc.stdout?.on("data", (b: Buffer) => chunks.push(b));
    // Missing binary (ENOENT) or any spawn error → empty output, don't throw.
    proc.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve("");
    });
    proc.on("close", done);

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      done();
    }, timeoutMs);
  });
}

const listOpencodeModels = async () => parseOpencodeModels(await captureCliStdout("opencode", ["models"]));
const listClaudeEfforts = async () => parseClaudeEfforts(await captureCliStdout("claude", ["--help"]));

/**
 * The models + efforts a given agent can run. Effort is a Claude-only concept and
 * its levels are discovered live from `claude --help`; opencode's models come from
 * `opencode models`. codex/gemini expose no CLI listing, so their model sets are
 * curated (ALLOWED_MODELS / CODEX_MODELS / GEMINI_MODELS). Unknown id → empty lists.
 */
export async function agentModels(id: AgentId): Promise<AgentModels> {
  if (id === "claude") {
    return { models: [...ALLOWED_MODELS], efforts: await listClaudeEfforts() };
  }
  if (id === "codex") {
    return { models: [...CODEX_MODELS], efforts: [] };
  }
  if (id === "gemini") {
    return { models: [...GEMINI_MODELS], efforts: [] };
  }
  if (id === "opencode") {
    return { models: await listOpencodeModels(), efforts: [] };
  }
  return { models: [], efforts: [] };
}
