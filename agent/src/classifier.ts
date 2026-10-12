import { isActionKind, type ActionLevel, type ActionLevels } from "@rigel/k8s/src/actionLevels.js";

export function levelFor(kind: string, levels: ActionLevels): ActionLevel {
  return isActionKind(kind) ? levels[kind] : "ask";
}
