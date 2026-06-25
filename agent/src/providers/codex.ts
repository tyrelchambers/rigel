import path, { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { provisionGuardBin } from "../guardedKubectl.js";
import { collectJsonlRun, type CollectedEvent } from "./process.js";
import { structuredInstruction, extractJsonObjectLoose } from "./structured.js";
import { errorResult, type ProviderBridge, type ProviderResult, type RunModelInput } from "./types.js";

const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku"]);

/** Build `codex exec --json …` argv. Pure + exported for unit tests. Mirrors
 *  apps/server/src/codexBridge.ts buildCodexArgs. The fullPrompt positional already
 *  embeds the system prompt (codex has no append-system-prompt flag). */
export function buildCodexArgs(fullPrompt: string, input: RunModelInput): string[] {
  const flags = [
    "--json",
    "-c", "sandbox_mode=workspace-write",
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", "approval_policy=never",
    "--skip-git-repo-check",
  ];
  if (input.model && !CLAUDE_ALIASES.has(input.model)) flags.push("-m", input.model);
  if (input.resumeSessionId) {
    return ["codex", "exec", "resume", input.resumeSessionId, ...flags, fullPrompt];
  }
  return ["codex", "exec", ...flags, fullPrompt];
}

function truncate(raw: string): string {
  return raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
}

/** Map ONE codex --json event to CollectedEvents. Mirrors mapCodexEvent in the chat. */
export function mapCodexEvent(ev: any): CollectedEvent[] {
  if (!ev || typeof ev !== "object") return [];
  if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
    return [{ type: "session", sessionId: ev.thread_id }];
  }
  if (ev.type === "turn.completed") return [{ type: "done" }];
  if (ev.type === "turn.failed") {
    const msg = ev.error?.message;
    return [{ type: "error", text: typeof msg === "string" ? msg : "Codex turn failed" }];
  }
  if (ev.type === "error") {
    const text = typeof ev.message === "string" ? ev.message : "Codex error";
    if (/^Reconnecting/i.test(text)) return [];
    return [{ type: "error", text }];
  }
  if (ev.type === "item.completed") {
    const item = ev.item;
    if (!item || typeof item !== "object") return [];
    if (item.type === "agent_message" && typeof item.text === "string") {
      return [{ type: "text", text: item.text }];
    }
    if (item.type === "reasoning" && typeof item.text === "string") {
      return [{ type: "thinking", text: truncate(item.text) }];
    }
  }
  return [];
}

export const codexBridge: ProviderBridge = {
  id: "codex",

  authEnv(): Record<string, string> | null {
    // Subscription (ChatGPT plan) auth.json content is preferred; CODEX_API_KEY
    // is the fallback. Materializing the file happens in run().
    const blob = process.env.CODEX_AUTH_CONTENT;
    if (blob && blob.trim()) return { CODEX_AUTH_CONTENT: blob };
    const key = process.env.CODEX_API_KEY;
    return key && key.trim() ? { CODEX_API_KEY: key } : null;
  },

  async run(input: RunModelInput): Promise<ProviderResult> {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rigel-codex-"));
    let guardBin: string | undefined;
    try {
      guardBin = await provisionGuardBin();
      const auth = this.authEnv();
      if (!auth)
        return errorResult(
          "Codex has no credential — add a ChatGPT auth file (CODEX_AUTH_CONTENT) or an API key (CODEX_API_KEY).",
        );

      const fullPrompt = composeCodexPrompt(input);
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...auth,
        PATH: `${guardBin}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      // Subscription auth: codex reads auth.json under CODEX_HOME (defaults to
      // ~/.codex). Write the supplied blob into a private CODEX_HOME and strip any
      // API-key env so codex uses the ChatGPT session rather than per-token billing.
      const blob = process.env.CODEX_AUTH_CONTENT;
      if (blob && blob.trim()) {
        const codexHome = join(workspaceDir, ".codex");
        await mkdir(codexHome, { recursive: true });
        await writeFile(join(codexHome, "auth.json"), blob);
        env.CODEX_HOME = codexHome;
        delete env.CODEX_AUTH_CONTENT;
        delete env.CODEX_API_KEY;
        delete env.OPENAI_API_KEY;
      }
      const run = await collectJsonlRun({
        argv: buildCodexArgs(fullPrompt, input),
        env,
        cwd: workspaceDir,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        mapEvent: mapCodexEvent,
      });
      if (run.isError) return errorResult(run.errorText ?? "Codex run failed");
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

/** System prompt + (optional structured instruction) + user prompt as one positional. */
function composeCodexPrompt(input: RunModelInput): string {
  const head = input.systemPrompt ? `${input.systemPrompt}\n\n` : "";
  const struct = input.structuredSchema ? `\n\n${structuredInstruction(input.structuredSchema)}` : "";
  return `${head}# Task\n${input.prompt}${struct}`;
}
