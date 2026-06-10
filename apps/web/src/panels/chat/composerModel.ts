/**
 * Model + reasoning-effort selection for the chat composer. Mirrors the Swift
 * `ClaudeModelConfig` — the selection is applied as `--model`/`--effort` flags
 * when the server launches the `claude` CLI, and persisted in localStorage.
 */

export const CLAUDE_MODELS = [
  { id: "opus", name: "Opus 4.8" },
  { id: "sonnet", name: "Sonnet 4.6" },
  { id: "haiku", name: "Haiku 4.5" },
] as const;
export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]["id"];

export const CLAUDE_EFFORTS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra high" },
  { id: "max", name: "Max" },
] as const;
export type ClaudeEffortId = (typeof CLAUDE_EFFORTS)[number]["id"];

export interface ModelConfig {
  model: ClaudeModelId;
  effort: ClaudeEffortId;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = { model: "opus", effort: "high" };

/** "Opus 4.8 · High" — the compact label shown on the composer pill. */
export function modelLabel(c: ModelConfig): string {
  const m = CLAUDE_MODELS.find((x) => x.id === c.model)?.name ?? c.model;
  const e = CLAUDE_EFFORTS.find((x) => x.id === c.effort)?.name ?? c.effort;
  return `${m} · ${e}`;
}

const STORAGE_KEY = "helmsman.chat.modelConfig";

export function loadModelConfig(): ModelConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ModelConfig>;
      if (
        CLAUDE_MODELS.some((m) => m.id === p.model) &&
        CLAUDE_EFFORTS.some((e) => e.id === p.effort)
      ) {
        return { model: p.model!, effort: p.effort! };
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_MODEL_CONFIG;
}

export function saveModelConfig(c: ModelConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}
