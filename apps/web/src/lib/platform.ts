import { rigel } from "./desktop";

export const isMac =
  rigel?.platform === "darwin" ||
  (typeof navigator !== "undefined" &&
    /mac/i.test(
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ??
        navigator.platform ??
        "",
    ));

export interface ShortcutSpec {
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  key: string;
}

export function formatShortcut(spec: ShortcutSpec): string {
  const { mod, alt, shift, ctrl, key } = spec;
  if (isMac) {
    let out = "";
    if (ctrl) out += "⌃";
    if (alt) out += "⌥";
    if (shift) out += "⇧";
    if (mod) out += "⌘";
    return out + key;
  }
  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  if (mod) parts.push("Ctrl");
  parts.push(key);
  return parts.join("+");
}

function sameKey(e: KeyboardEvent, key: string): boolean {
  const want = key.toLowerCase();
  if (e.key && e.key.toLowerCase() === want) return true;
  if (want.length === 1 && want >= "a" && want <= "z") {
    return e.code === `Key${want.toUpperCase()}`;
  }
  return false;
}

export function matchShortcut(e: KeyboardEvent, spec: ShortcutSpec): boolean {
  const wantMeta = isMac && Boolean(spec.mod);
  const wantCtrl = Boolean(spec.ctrl) || (!isMac && Boolean(spec.mod));
  if (e.metaKey !== wantMeta) return false;
  if (e.ctrlKey !== wantCtrl) return false;
  if (e.altKey !== Boolean(spec.alt)) return false;
  if (e.shiftKey !== Boolean(spec.shift)) return false;
  return sameKey(e, spec.key);
}
