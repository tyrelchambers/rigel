import { formatShortcut, matchShortcut, type ShortcutSpec } from "@/lib/platform";
import type { Overrides } from "@/store/shortcuts";
import { COMMANDS, COMMAND_BY_ID, type CommandId } from "./registry";

export function sameSpec(a: ShortcutSpec, b: ShortcutSpec): boolean {
  return (
    Boolean(a.mod) === Boolean(b.mod) &&
    Boolean(a.ctrl) === Boolean(b.ctrl) &&
    Boolean(a.alt) === Boolean(b.alt) &&
    Boolean(a.shift) === Boolean(b.shift) &&
    a.key.toLowerCase() === b.key.toLowerCase()
  );
}

export function resolveSpec(id: CommandId, overrides: Overrides): ShortcutSpec | null {
  if (id in overrides) return overrides[id] ?? null;
  return COMMAND_BY_ID.get(id)?.defaultSpec ?? null;
}

export function resolveCommand(e: KeyboardEvent, overrides: Overrides): CommandId | null {
  for (const cmd of COMMANDS) {
    const spec = resolveSpec(cmd.id, overrides);
    if (spec && matchShortcut(e, spec)) return cmd.id;
    if (!(cmd.id in overrides) && cmd.aliases?.some((a) => matchShortcut(e, a))) return cmd.id;
  }
  return null;
}

export function findConflict(spec: ShortcutSpec, id: CommandId, overrides: Overrides): CommandId | null {
  for (const cmd of COMMANDS) {
    if (cmd.id === id) continue;
    const other = resolveSpec(cmd.id, overrides);
    if (other && sameSpec(other, spec)) return cmd.id;
  }
  return null;
}

export function shortcutLabelFor(id: CommandId, overrides: Overrides): string | null {
  const spec = resolveSpec(id, overrides);
  return spec ? formatShortcut(spec) : null;
}
