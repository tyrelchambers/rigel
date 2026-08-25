import type { ShortcutSpec } from "@/lib/platform";

export type CommandId =
  | "palette.open"
  | "nav.launcher"
  | "nav.back"
  | "nav.forward"
  | "chat.toggle"
  | "chat.focusComposer"
  | "terminal.toggle"
  | "logs.toggleWrap"
  | "voice.toggle";

export type CommandGroup = "Navigation" | "Chat" | "Voice" | "Panels";

export interface CommandDef {
  id: CommandId;
  label: string;
  group: CommandGroup;
  defaultSpec: ShortcutSpec;
  aliases?: ShortcutSpec[];
  inInput?: "auto" | "block";
}

export const COMMANDS: CommandDef[] = [
  {
    id: "palette.open",
    label: "Open the command palette",
    group: "Navigation",
    defaultSpec: { mod: true, key: "K" },
  },
  {
    id: "nav.launcher",
    label: "Open the navigation launcher",
    group: "Navigation",
    defaultSpec: { mod: true, key: "/" },
  },
  {
    id: "nav.back",
    label: "Go back",
    group: "Navigation",
    defaultSpec: { mod: true, key: "[" },
    aliases: [{ mod: true, key: "ArrowLeft" }],
    inInput: "block",
  },
  {
    id: "nav.forward",
    label: "Go forward",
    group: "Navigation",
    defaultSpec: { mod: true, key: "]" },
    aliases: [{ mod: true, key: "ArrowRight" }],
    inInput: "block",
  },
  {
    id: "chat.toggle",
    label: "Show or hide the chat pane",
    group: "Chat",
    defaultSpec: { mod: true, key: "J" },
  },
  {
    id: "chat.focusComposer",
    label: "Focus the chat composer",
    group: "Chat",
    defaultSpec: { mod: true, key: "L" },
  },
  {
    id: "terminal.toggle",
    label: "Show or hide the terminal",
    group: "Panels",
    defaultSpec: { ctrl: true, key: "`" },
  },
  {
    id: "logs.toggleWrap",
    label: "Wrap log lines",
    group: "Panels",
    defaultSpec: { alt: true, mod: true, key: "W" },
  },
  {
    id: "voice.toggle",
    label: "Start or end a voice session",
    group: "Voice",
    defaultSpec: { alt: true, mod: true, key: "V" },
  },
];

export const COMMAND_BY_ID: Map<CommandId, CommandDef> = new Map(COMMANDS.map((c) => [c.id, c]));

export const COMMAND_GROUPS: CommandGroup[] = ["Navigation", "Chat", "Panels", "Voice"];
