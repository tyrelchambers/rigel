import { describe, it, expect } from "vitest";
import { COMMANDS, COMMAND_BY_ID } from "./registry";

function fingerprint(spec: { mod?: boolean; alt?: boolean; shift?: boolean; ctrl?: boolean; key: string }): string {
  return [spec.mod ? "mod" : "", spec.ctrl ? "ctrl" : "", spec.alt ? "alt" : "", spec.shift ? "shift" : "", spec.key.toLowerCase()].join("+");
}

describe("COMMANDS", () => {
  it("has nine commands", () => {
    expect(COMMANDS).toHaveLength(9);
  });

  it("gives every command a label and a group", () => {
    for (const cmd of COMMANDS) {
      expect(cmd.label.length).toBeGreaterThan(0);
      expect(["Navigation", "Chat", "Voice", "Panels"]).toContain(cmd.group);
    }
  });

  it("never binds two commands to the same combination", () => {
    const seen = new Map<string, string>();
    for (const cmd of COMMANDS) {
      for (const spec of [cmd.defaultSpec, ...(cmd.aliases ?? [])]) {
        const fp = fingerprint(spec);
        expect(seen.has(fp), `${fp} claimed by both ${seen.get(fp)} and ${cmd.id}`).toBe(false);
        seen.set(fp, cmd.id);
      }
    }
  });

  it("indexes every command by id", () => {
    expect(COMMAND_BY_ID.size).toBe(COMMANDS.length);
    expect(COMMAND_BY_ID.get("voice.toggle")?.defaultSpec).toEqual({ alt: true, mod: true, key: "V" });
  });

  it("blocks the nav-history commands inside text fields", () => {
    expect(COMMAND_BY_ID.get("nav.back")?.inInput).toBe("block");
    expect(COMMAND_BY_ID.get("nav.forward")?.inInput).toBe("block");
  });
});
