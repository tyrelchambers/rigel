export type ActionLevel = "auto" | "review" | "ask" | "off";
export type ActionKind = "restart" | "rollback" | "deletePod" | "cordon" | "uncordon" | "scale" | "setEnv" | "openFixPR";
export type ActionLevels = Record<ActionKind, ActionLevel>;
export type PresetId = "loose" | "balanced" | "strict";

export const ACTION_LEVEL_VALUES: readonly ActionLevel[] = ["auto", "review", "ask", "off"];

export const ACTION_LEVEL_KINDS: readonly { kind: ActionKind; label: string; description: string }[] = [
  { kind: "restart", label: "Restart", description: "Roll out a fresh copy of a deployment" },
  { kind: "rollback", label: "Roll back", description: "Return a deployment to its previous version" },
  { kind: "deletePod", label: "Delete pod", description: "Remove a stuck pod so its controller replaces it" },
  { kind: "cordon", label: "Cordon", description: "Stop new pods landing on an unhealthy node" },
  { kind: "uncordon", label: "Uncordon", description: "Let pods schedule on a node again" },
  { kind: "scale", label: "Scale", description: "Change how many replicas a deployment runs" },
  { kind: "setEnv", label: "Set env", description: "Change a deployment's environment variables" },
  { kind: "openFixPR", label: "Open fix PR", description: "Open a pull request against the workload's repo" },
];

export const PRESETS: Record<PresetId, ActionLevels> = {
  loose: { restart: "auto", rollback: "auto", deletePod: "auto", cordon: "auto", uncordon: "auto", scale: "auto", setEnv: "review", openFixPR: "review" },
  balanced: { restart: "auto", rollback: "auto", deletePod: "auto", cordon: "auto", uncordon: "auto", scale: "review", setEnv: "review", openFixPR: "review" },
  strict: { restart: "review", rollback: "ask", deletePod: "review", cordon: "ask", uncordon: "ask", scale: "ask", setEnv: "ask", openFixPR: "ask" },
};

export function isActionKind(kind: string): kind is ActionKind {
  return ACTION_LEVEL_KINDS.some((k) => k.kind === kind);
}

export function parseActionLevels(raw: string | undefined): ActionLevels {
  if (raw === undefined || raw.trim() === "") return { ...PRESETS.balanced };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return Object.fromEntries(ACTION_LEVEL_KINDS.map((k) => [k.kind, "ask"])) as ActionLevels;
  }
  const stored = parsed as Record<string, unknown>;
  const out = { ...PRESETS.balanced };
  for (const { kind } of ACTION_LEVEL_KINDS) {
    if (!(kind in stored)) continue;
    const v = stored[kind];
    out[kind] = ACTION_LEVEL_VALUES.includes(v as ActionLevel) ? (v as ActionLevel) : "ask";
  }
  return out;
}

export function matchPreset(levels: ActionLevels): PresetId | null {
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    if (ACTION_LEVEL_KINDS.every(({ kind }) => PRESETS[id][kind] === levels[kind])) return id;
  }
  return null;
}

export function serializeActionLevels(levels: ActionLevels): string {
  return JSON.stringify(Object.fromEntries(ACTION_LEVEL_KINDS.map(({ kind }) => [kind, levels[kind]])));
}
