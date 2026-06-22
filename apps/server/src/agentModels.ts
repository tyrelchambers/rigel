// Per-agent model + effort lists, for the composer's agent-aware model picker.
//
// The web composer asks the server "what models can THIS agent run?" and renders
// a picker from the result. claude/codex are static sets; opencode is discovered
// live via `opencode models`. Effort is a Claude-only concept (the others return
// an empty efforts list), mirroring the runner wiring in claudeBridge/codexBridge/
// opencodeBridge.
import { spawn } from "node:child_process";
import { ALLOWED_MODELS, ALLOWED_EFFORTS } from "./claudeBridge";
import type { AgentId } from "./agentRegistry";

export interface AgentModels {
  /** Selectable model ids for this agent (may be empty if none are known). */
  models: string[];
  /** Selectable reasoning-effort levels (Claude-only; empty for the others). */
  efforts: string[];
}

/**
 * Codex model list. STATIC + PROVISIONAL: codex isn't runnable on the dev machine,
 * so this is a best-effort set to refine once codex is live-verified. Unlike
 * opencode there's no cheap "list models" command to discover these.
 */
const CODEX_MODELS = ["gpt-5-codex", "gpt-5", "o4-mini"];

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
 * Run `opencode models` and parse its stdout. Returns [] (never throws) if the
 * spawn fails — e.g. opencode isn't installed. Captures stdout fully (it's a short
 * listing) and kills the process after a modest timeout so a hang can't block.
 */
async function listOpencodeModels(): Promise<string[]> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (out: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(parseOpencodeModels(out));
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("opencode", ["models"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve([]); // spawn threw synchronously (rare) → no models
      return;
    }

    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (b: Buffer) => chunks.push(b));
    // Missing binary (ENOENT) or any spawn error → no models, don't throw.
    proc.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve([]);
    });
    proc.on("close", () => done(Buffer.concat(chunks).toString("utf8")));

    // Guard against a hang: `opencode models` exits on its own, but kill after 10s
    // and parse whatever we captured so the picker request can't stall forever.
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      done(Buffer.concat(chunks).toString("utf8"));
    }, 10_000);
  });
}

/**
 * The models + efforts a given agent can run. claude/codex are static; opencode is
 * discovered live via `opencode models`; an unknown id yields empty lists.
 */
export async function agentModels(id: AgentId): Promise<AgentModels> {
  if (id === "claude") {
    // Reuse claudeBridge's ALLOWED_* so the picker stays in sync with the runner.
    return { models: [...ALLOWED_MODELS], efforts: [...ALLOWED_EFFORTS] };
  }
  if (id === "codex") {
    return { models: [...CODEX_MODELS], efforts: [] };
  }
  if (id === "opencode") {
    return { models: await listOpencodeModels(), efforts: [] };
  }
  return { models: [], efforts: [] };
}
