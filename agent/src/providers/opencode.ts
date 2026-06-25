import path, { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { provisionGuardBin } from "../guardedKubectl.js";
import { collectJsonlRun, type CollectedEvent } from "./process.js";
import { structuredInstruction, extractJsonObjectLoose } from "./structured.js";
import { errorResult, type ProviderBridge, type ProviderResult, type RunModelInput } from "./types.js";

const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku"]);

/** Build `opencode run …` argv. Pure + exported. Mirrors apps/server opencodeBridge. */
export function buildOpencodeArgs(fullPrompt: string, input: RunModelInput, runDir: string): string[] {
  const flags = ["--format", "json", "--thinking", "--dir", runDir];
  if (input.model && !CLAUDE_ALIASES.has(input.model)) flags.push("-m", input.model);
  if (input.resumeSessionId) return ["opencode", "run", ...flags, "-s", input.resumeSessionId, fullPrompt];
  return ["opencode", "run", ...flags, fullPrompt];
}

function truncate(raw: string): string {
  return raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
}

/** Map ONE opencode --format json event. Mirrors mapOpencodeEvent in the chat. */
export function mapOpencodeEvent(ev: any): CollectedEvent[] {
  if (!ev || typeof ev !== "object") return [];
  if (ev.type === "text") {
    const t = ev.part?.text;
    return typeof t === "string" && t.length > 0 ? [{ type: "text", text: t }] : [];
  }
  if (ev.type === "reasoning") {
    const t = ev.part?.text;
    return typeof t === "string" && t.length > 0 ? [{ type: "thinking", text: truncate(t) }] : [];
  }
  if (ev.type === "step_start") {
    return typeof ev.sessionID === "string" ? [{ type: "session", sessionId: ev.sessionID }] : [];
  }
  if (ev.type === "step_finish") return [];
  if (ev.type === "error") {
    const msg = ev.error?.data?.message;
    const text =
      typeof msg === "string" && msg.length > 0
        ? msg
        : typeof ev.error?.name === "string"
          ? ev.error.name
          : "opencode error";
    return [{ type: "error", text }];
  }
  return [];
}

export const opencodeBridge: ProviderBridge = {
  id: "opencode",

  authEnv(): Record<string, string> | null {
    const blob = process.env.OPENCODE_AUTH_CONTENT;
    if (blob && blob.trim()) return { OPENCODE_AUTH_CONTENT: blob };
    const key = process.env.OPENCODE_API_KEY;
    if (key && key.trim()) return { OPENCODE_API_KEY: key };
    return null;
  },

  async run(input: RunModelInput): Promise<ProviderResult> {
    const runDir = await mkdtemp(join(tmpdir(), "rigel-opencode-"));
    // Headless permission config: allow by default (read-only kubectl runs), DENY
    // edit/webfetch/websearch, no "ask" (would stall headless). The guard shim still
    // denies cluster mutations on top of the allowed bash tool.
    await writeFile(
      join(runDir, "opencode.json"),
      JSON.stringify({ permission: { "*": "allow", edit: "deny", webfetch: "deny", websearch: "deny" } }),
    );
    let guardBin: string | undefined;
    try {
      guardBin = await provisionGuardBin();
      const auth = this.authEnv();
      if (!auth) return errorResult("OpenCode has no credential — add OPENCODE_AUTH_CONTENT or OPENCODE_API_KEY.");

      const head = input.systemPrompt ? `${input.systemPrompt}\n\n` : "";
      const struct = input.structuredSchema ? `\n\n${structuredInstruction(input.structuredSchema)}` : "";
      const fullPrompt = `${head}# Task\n${input.prompt}${struct}`;

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...auth,
        PATH: `${guardBin}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const run = await collectJsonlRun({
        argv: buildOpencodeArgs(fullPrompt, input, runDir),
        env,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        mapEvent: mapOpencodeEvent,
      });
      if (run.isError) return errorResult(run.errorText ?? "OpenCode run failed");
      const structuredOutput = input.structuredSchema ? extractJsonObjectLoose(run.text) ?? undefined : undefined;
      return { text: run.text, costUsd: 0, isError: false, sessionId: run.sessionId, structuredOutput };
    } catch (e) {
      return errorResult(String(e instanceof Error ? e.message : e));
    } finally {
      await rm(runDir, { recursive: true, force: true });
      if (guardBin) await rm(guardBin, { recursive: true, force: true });
    }
  },
};
