/** Which install command to show, and what to call the tool that runs it. */
export function detectOS(): "macos" | "linux" | "windows" | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return null;
}

/** Map a command's first token to a human-readable package manager label. */
export function pkgLabel(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const map: Record<string, string> = {
    brew: "Homebrew",
    snap: "Snap",
    scoop: "Scoop",
    apt: "APT",
    choco: "Chocolatey",
    winget: "winget",
  };
  return map[first] ?? first;
}
