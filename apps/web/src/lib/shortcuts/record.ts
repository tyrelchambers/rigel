import { isMac, type ShortcutSpec } from "@/lib/platform";

const BARE_MODIFIERS = new Set(["Meta", "Control", "Alt", "Shift"]);

function keyFromEvent(e: KeyboardEvent): string {
  if (e.code.startsWith("Key")) return e.code.slice(3);
  if (e.code.startsWith("Digit")) return e.code.slice(5);
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

export function specFromEvent(e: KeyboardEvent): ShortcutSpec | null {
  if (BARE_MODIFIERS.has(e.key) || e.key === "Escape") return null;
  return {
    mod: isMac ? e.metaKey : e.ctrlKey,
    ctrl: isMac ? e.ctrlKey : false,
    alt: e.altKey,
    shift: e.shiftKey,
    key: keyFromEvent(e),
  };
}

export function hasModifier(spec: ShortcutSpec): boolean {
  return Boolean(spec.mod || spec.ctrl || spec.alt);
}
