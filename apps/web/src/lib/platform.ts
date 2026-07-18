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
