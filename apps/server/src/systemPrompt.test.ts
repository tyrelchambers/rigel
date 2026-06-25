import { test, expect } from "vitest";
import { systemPrompt } from "./systemPrompt";

test("single-context prompt has no fan-out section", () => {
  const p = systemPrompt("dev");
  expect(p).toContain("Active kubectl context: `dev`");
  expect(p).not.toContain("READ-ONLY FAN-OUT");
});

test("prompt with extra read contexts appends a fan-out section naming the OTHER clusters only", () => {
  const p = systemPrompt("dev", ["dev", "prod", "stage"]);
  expect(p).toContain("READ-ONLY FAN-OUT");
  expect(p).toContain("`prod`");
  expect(p).toContain("`stage`");
  expect(p).not.toContain("`dev`, `prod`"); // the active context is NOT listed as an "other"
  expect(p.toLowerCase()).toContain("only");
});

test("readContexts equal to just the active context produces NO fan-out section", () => {
  expect(systemPrompt("dev", ["dev"])).not.toContain("READ-ONLY FAN-OUT");
});
