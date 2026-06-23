import { describe, expect, test } from "vitest";
import { checkCli, formatSelfCheck, type CliPresence } from "./selfCheck.js";

describe("checkCli", () => {
  test("resolves true for a binary that exists (node)", async () => {
    expect(await checkCli("node")).toBe(true);
  });
  test("resolves false for a binary that does not exist", async () => {
    expect(await checkCli("definitely-not-a-real-cli-xyz")).toBe(false);
  });
});

describe("formatSelfCheck", () => {
  test("renders present/absent per provider", () => {
    const presence: CliPresence = { claude: true, codex: false, gemini: true, opencode: false };
    const line = formatSelfCheck(presence);
    expect(line).toMatch(/claude: present/);
    expect(line).toMatch(/codex: absent/);
    expect(line).toMatch(/gemini: present/);
    expect(line).toMatch(/opencode: absent/);
  });
});
