// Per-agent model + effort lists, for the composer's agent-aware model picker.
//
// The web composer asks the server "what models can THIS agent run?" and renders a
// picker from the result. Model lists are curated for claude/codex/gemini (their
// CLIs expose no list-models command) and discovered live for opencode (`opencode
// models`). Effort lists are curated per provider (see each runner bridge) — every
// provider except gemini exposes a reasoning-effort lever the runner passes through.
import { spawn } from "node:child_process";
import { ALLOWED_MODELS, ALLOWED_EFFORTS } from "./claudeBridge";
import { CODEX_EFFORTS } from "./codexBridge";
import { OPENCODE_EFFORTS } from "./opencodeBridge";
import type { AgentId } from "./agentRegistry";

export interface AgentModels {
  /** Selectable model ids for this agent (may be empty if none are known). */
  models: string[];
  /** Selectable reasoning-effort levels (empty for gemini, which has no CLI lever). */
  efforts: string[];
}

/**
 * Codex model list. CURATED: the `codex` CLI has no "list models" command (verified
 * against codex-cli 0.141 — `codex models` is treated as a prompt, not a subcommand;
 * it only takes `-m`/`--model`), so this is a hand-maintained set of the current
 * Codex-runnable models. Update when OpenAI ships new ones.
 */
const CODEX_MODELS = ["gpt-5-codex", "gpt-5.4", "gpt-5"];

/**
 * Gemini model list. CURATED: gemini-cli has no "list models" command (verified
 * against gemini 0.27 — only `-m`/`--model`), so this is a hand-maintained set of
 * the current Gemini models (the 3.x line, then the prior 2.5 line). Update when
 * Google ships new ones.
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

/**
 * The models + efforts a given agent can run. Model sets are curated for
 * claude/codex/gemini and discovered live for opencode (`opencode models`). Effort
 * sets are curated per runner bridge (ALLOWED_EFFORTS / CODEX_EFFORTS /
 * OPENCODE_EFFORTS); gemini's is empty because its CLI has no effort lever. Unknown
 * id → empty lists.
 */
export async function agentModels(id: AgentId): Promise<AgentModels> {
  if (id === "claude") {
    return { models: [...ALLOWED_MODELS], efforts: [...ALLOWED_EFFORTS] };
  }
  if (id === "codex") {
    return { models: [...CODEX_MODELS], efforts: [...CODEX_EFFORTS] };
  }
  if (id === "gemini") {
    return { models: [...GEMINI_MODELS], efforts: [] };
  }
  if (id === "opencode") {
    return { models: await listOpencodeModels(), efforts: [...OPENCODE_EFFORTS] };
  }
  return { models: [], efforts: [] };
}
