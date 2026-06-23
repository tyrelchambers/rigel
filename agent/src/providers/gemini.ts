import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionGuardBin } from "../guardedKubectl.js";
import { collectJsonlRun, type CollectedEvent } from "./process.js";
import { structuredInstruction, extractJsonObjectLoose } from "./structured.js";
import { errorResult, type ProviderBridge, type ProviderResult, type RunModelInput } from "./types.js";

const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku"]);

/** Build `gemini …` argv. Pure + exported. Mirrors apps/server geminiBridge.
 *  --approval-mode yolo auto-approves tools (the guard shim still denies mutations).
 *  No resume: gemini runs fresh per turn (documented limitation). */
export function buildGeminiArgs(fullPrompt: string, input: RunModelInput): string[] {
  const argv = ["gemini", "-p", fullPrompt, "-o", "stream-json", "--approval-mode", "yolo"];
  if (input.model && !CLAUDE_ALIASES.has(input.model)) argv.push("-m", input.model);
  return argv;
}

/** Map ONE gemini stream-json event. Mirrors mapGeminiEvent in the chat. */
export function mapGeminiEvent(ev: any): CollectedEvent[] {
  if (!ev || typeof ev !== "object") return [];
  if (ev.type === "init") {
    return typeof ev.session_id === "string" ? [{ type: "session", sessionId: ev.session_id }] : [];
  }
  if (ev.type === "message") {
    return ev.role === "assistant" && typeof ev.content === "string" ? [{ type: "text", text: ev.content }] : [];
  }
  if (ev.type === "error") {
    return ev.severity === "error"
      ? [{ type: "error", text: typeof ev.message === "string" ? ev.message : "Gemini error" }]
      : [];
  }
  if (ev.type === "result") {
    if (ev.status === "error") {
      const msg = ev.error?.message;
      return [{ type: "error", text: typeof msg === "string" ? msg : "Gemini turn failed" }, { type: "done" }];
    }
    return [{ type: "done" }];
  }
  return [];
}

export const geminiBridge: ProviderBridge = {
  id: "gemini",

  authEnv(): Record<string, string> | null {
    const key = process.env.GEMINI_API_KEY;
    return key && key.trim() ? { GEMINI_API_KEY: key } : null;
  },

  async run(input: RunModelInput): Promise<ProviderResult> {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rigel-gemini-"));
    let guardBin: string | undefined;
    try {
      guardBin = await provisionGuardBin();
      const auth = this.authEnv();
      if (!auth) return errorResult("Gemini has no GEMINI_API_KEY — add a key for this provider.");

      const head = input.systemPrompt ? `${input.systemPrompt}\n\n` : "";
      const struct = input.structuredSchema ? `\n\n${structuredInstruction(input.structuredSchema)}` : "";
      const fullPrompt = `${head}# Task\n${input.prompt}${struct}`;

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...auth,
        PATH: `${guardBin}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const run = await collectJsonlRun({
        argv: buildGeminiArgs(fullPrompt, input),
        env,
        cwd: workspaceDir,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        mapEvent: mapGeminiEvent,
      });
      if (run.isError) return errorResult(run.errorText ?? "Gemini run failed");
      const structuredOutput = input.structuredSchema ? extractJsonObjectLoose(run.text) ?? undefined : undefined;
      return { text: run.text, costUsd: 0, isError: false, sessionId: run.sessionId, structuredOutput };
    } catch (e) {
      return errorResult(String(e instanceof Error ? e.message : e));
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      if (guardBin) await rm(guardBin, { recursive: true, force: true });
    }
  },
};
