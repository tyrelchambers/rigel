/**
 * Model + reasoning-effort selection for the chat composer.
 *
 * The composer is agent-aware: the model list (and whether a reasoning-effort
 * section exists) comes from the ACTIVE agent's `GET /api/agents/<id>/models`
 * response, not a hardcoded Claude set. The chosen `{ model, effort }` is applied
 * as `--model`/`--effort` flags when the server launches that agent's runner.
 * Effort is a Claude-only concept; the other agents return an empty efforts list
 * and we omit effort for them.
 *
 * Selection is persisted PER AGENT (so switching the active agent restores that
 * agent's last choice). See `loadModelConfigs`/`saveModelConfig`.
 */
import type { AgentId } from "@/lib/api";

/** Claude pretty-name table (the others show their raw model id). */
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

/**
 * A single agent's composer selection. `model` is the raw model id the agent
 * advertises (a Claude alias like "opus", a Codex id like "gpt-5-codex", or an
 * OpenCode `provider/model`). `effort` is Claude-only and omitted otherwise.
 */
export interface ModelConfig {
  model: string;
  effort?: string;
}

/** Claude's defaults — used when an agent has no stored choice and is Claude. */
export const DEFAULT_MODEL_CONFIG: ModelConfig = { model: "opus", effort: "high" };

/** "Opus 4.8" for a Claude alias; the raw id for any other agent. */
export function modelName(agentId: AgentId | undefined, model: string): string {
  if (agentId === "claude") {
    return CLAUDE_MODELS.find((m) => m.id === model)?.name ?? model;
  }
  return model;
}

/** Pretty label for an effort id (Claude only); falls back to the raw id. */
export function effortName(effort: string): string {
  return CLAUDE_EFFORTS.find((e) => e.id === effort)?.name ?? effort;
}

/**
 * Chip label for the composer. Claude shows "Sonnet 4.6"; the others show the
 * raw model id (e.g. "gpt-5-codex" / "claude-sonnet-4-6"). The effort is NOT
 * part of the chip in the agent-aware design — it lives in the dropdown.
 */
export function modelLabel(agentId: AgentId | undefined, model: string): string {
  return modelName(agentId, model);
}

// ── Per-agent persistence ─────────────────────────────────────────────────────
//
// v2 stores a map keyed by agentId: { [agentId]: { model, effort } }. The old v1
// single-value key (one global Claude config) is migrated to the "claude" slot on
// first read, then removed.

const STORAGE_KEY = "rigel.modelConfig.v2";
const LEGACY_KEY = "rigel.chat.modelConfig";

export type ModelConfigMap = Partial<Record<AgentId, ModelConfig>>;

function isModelConfig(v: unknown): v is ModelConfig {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { model?: unknown }).model === "string"
  );
}

/** Read the per-agent map, migrating a legacy single-value config into "claude". */
export function loadModelConfigs(): ModelConfigMap {
  let map: ModelConfigMap = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (isModelConfig(v)) map[k as AgentId] = v;
      }
      return map;
    }
  } catch {
    /* ignore — fall through to migration / empty */
  }
  // Migrate the legacy global config (Claude-only) into the "claude" slot.
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const p = JSON.parse(legacy) as Partial<ModelConfig>;
      if (typeof p.model === "string") {
        map = { claude: { model: p.model, effort: p.effort } };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
      }
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch {
    /* ignore */
  }
  return map;
}

/** Persist one agent's selection, merging into the stored per-agent map. */
export function saveModelConfig(agentId: AgentId, config: ModelConfig): void {
  try {
    const map = loadModelConfigs();
    map[agentId] = config;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/**
 * Resolve the active selection for an agent from a stored map + the agent's
 * currently-advertised models/efforts:
 *  - use the stored model when it's still in the agent's list;
 *  - otherwise default to the first model in the list (Claude keeps the existing
 *    "opus" default when present);
 *  - effort applies only when the agent has efforts (Claude): keep the stored or
 *    default effort, else omit it.
 * Returns `null` while the model list is still empty/unknown (nothing to pick).
 */
export function resolveModelConfig(
  agentId: AgentId | undefined,
  stored: ModelConfig | undefined,
  models: string[],
  efforts: string[],
): ModelConfig | null {
  if (models.length === 0) return null;

  const model =
    stored && models.includes(stored.model)
      ? stored.model
      : agentId === "claude" && models.includes(DEFAULT_MODEL_CONFIG.model)
        ? DEFAULT_MODEL_CONFIG.model
        : models[0]!;

  if (efforts.length === 0) return { model };

  const effort =
    stored?.effort && efforts.includes(stored.effort)
      ? stored.effort
      : efforts.includes(DEFAULT_MODEL_CONFIG.effort!)
        ? DEFAULT_MODEL_CONFIG.effort
        : efforts[0]!;

  return { model, effort };
}
