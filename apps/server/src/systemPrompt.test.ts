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

  test("teaches the Git-managed route: check the link, then propose a pull request", () => {
    const p = voiceSystemPrompt("prod");
    expect(p).toContain("checkGitLink");
    expect(p).toContain("proposeRepoFix");
    expect(p).toContain("overwritten the next time it syncs");
    expect(p).toContain("not linked to a repository");
  });

  // The tool's schema names the kinds and their fields, so the prompt saying
  // it again is duplication that can drift. It points at the schema instead.
  test("leaves the vocabulary to the schema rather than reciting it", () => {
    const p = voiceSystemPrompt("prod");
    expect(p).toContain("Its schema lists every kind");
    expect(p).not.toContain("sourceId");
    expect(p).not.toContain("suspendCronJob");
    expect(p).not.toContain('{"op":"setImage"');
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

test("the voice prompt routes unmodelled changes to a real kind", () => {
  const p = voiceSystemPrompt("prod");
  expect(p).toContain("annotate");
  expect(p).toContain("the command kind");
  // Inventing a kind is impossible now that the tool has a schema, so the
  // prompt no longer forbids it. What it still has to say is that being unable
  // to name a change is not a reason to tell the operator it cannot be done.
  expect(p).toContain("Never tell the user a change is impossible");
});

test("the voice prompt never asks for a spoken confirmation", () => {
  const p = voiceSystemPrompt("prod");
  expect(p).toContain("Nothing you hear can run a change");
  expect(p).toContain("never treat a word you heard as approval");
});

test("the voice prompt splits changes it may run from changes it must surface", () => {
  const p = voiceSystemPrompt("prod");
  expect(p).toContain("destroys nothing");
  expect(p).toContain("anything destructive");
  expect(p).toContain("for the operator to approve");
});
