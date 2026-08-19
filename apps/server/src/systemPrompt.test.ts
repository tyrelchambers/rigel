import { test, expect, describe, it } from "vitest";
import { systemPrompt, voiceSystemPrompt } from "./systemPrompt";

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

describe("systemPrompt status callouts", () => {
  it("instructs the model to use GitHub-style alert syntax", () => {
    const prompt = systemPrompt("prod");
    expect(prompt).toContain("[!WARNING]");
    expect(prompt).toContain("[!TIP]");
  });
});

describe("voiceSystemPrompt", () => {
  test("names the active context and forbids markdown", () => {
    const p = voiceSystemPrompt("prod");
    expect(p).toContain("prod");
    expect(p).toContain("Never use markdown");
    expect(p).toContain("proposeMutation");
    expect(p).toContain("readCluster");
  });

  test("demands the count and forbids silently dropping results", () => {
    const p = voiceSystemPrompt("prod");
    expect(p).toContain("Always say the count");
    expect(p).toContain("never drop results silently");
  });

  test("pins the turn to the question just asked", () => {
    expect(voiceSystemPrompt("prod")).toContain("Answer the question just asked");
  });

  test("requires identifiers verbatim, and both names when two fit", () => {
    const p = voiceSystemPrompt("prod");
    expect(p).toContain("exactly as they are spelled");
    expect(p).toContain("say both");
  });

  test("does not modify the chat prompt", () => {
    expect(systemPrompt("prod", ["prod"])).not.toContain("You are SPEAKING aloud");
  });
});
