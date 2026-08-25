import { useEffect, useMemo, useRef } from "react";
import type { ShortcutSpec } from "@/lib/platform";
import { useShortcutStore } from "@/store/shortcuts";
import { COMMAND_BY_ID, type CommandDef, type CommandId } from "./registry";
import { resolveCommand, resolveSpec, shortcutLabelFor } from "./resolve";

type Handler = () => void;

const handlers = new Map<CommandId, Handler[]>();

export function runCommand(id: CommandId): boolean {
  const list = handlers.get(id);
  if (!list || list.length === 0) return false;
  list[list.length - 1]();
  return true;
}

export function useCommand(id: CommandId, handler: Handler, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const fn: Handler = () => ref.current();
    const list = handlers.get(id) ?? [];
    list.push(fn);
    handlers.set(id, list);
    return () => {
      const current = handlers.get(id);
      if (!current) return;
      const at = current.indexOf(fn);
      if (at >= 0) current.splice(at, 1);
      if (current.length === 0) handlers.delete(id);
    };
  }, [id, enabled]);
}

function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

export function allowsInput(cmd: CommandDef, spec: ShortcutSpec): boolean {
  if (cmd.inInput === "block") return false;
  return Boolean(spec.mod || spec.ctrl || spec.alt);
}

export function useShortcutDispatch(): void {
  const overrides = useShortcutStore((s) => s.overrides);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const id = resolveCommand(e, overrides);
      if (!id) return;
      const cmd = COMMAND_BY_ID.get(id);
      const spec = resolveSpec(id, overrides);
      if (!cmd || !spec) return;
      if (isTextTarget(e.target) && !allowsInput(cmd, spec)) return;
      if (runCommand(id)) e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overrides]);
}

export function useShortcutLabel(id: CommandId): string | null {
  const overrides = useShortcutStore((s) => s.overrides);
  return useMemo(() => shortcutLabelFor(id, overrides), [id, overrides]);
}
