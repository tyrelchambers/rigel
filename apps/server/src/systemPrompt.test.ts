import { test, expect, describe, it } from "vitest";
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

describe("systemPrompt status callouts", () => {
  it("instructs the model to use GitHub-style alert syntax", () => {
    const prompt = systemPrompt("prod");
    expect(prompt).toContain("[!WARNING]");
    expect(prompt).toContain("[!TIP]");
  });
});

describe("systemPrompt ssh section", () => {
  it("is omitted with no hosts", () => {
    expect(systemPrompt("ctx", ["ctx"], [])).not.toContain("SSH HOSTS");
  });
  it("names the hosts and the action kind", () => {
    const p = systemPrompt("ctx", ["ctx"], ["web-1", "nas"]);
    expect(p).toContain("SSH HOSTS");
    expect(p).toContain("`web-1`, `nas`");
    expect(p).toContain("sshCommand");
  });
  it("tells the model to flag root commands with sudo and leave the password to the user", () => {
    const p = systemPrompt("ctx", ["ctx"], ["web-1"]);
    expect(p).toContain('"sudo":true');
    expect(p).toContain("without the sudo prefix");
    expect(p).toContain("password in the confirm dialog");
  });
  it("teaches long or network-disrupting jobs to run detached while their journal streams", () => {
    const p = systemPrompt("ctx", ["ctx"], ["web-1"]);
    expect(p).toContain("--no-block");
    expect(p).toContain("journalctl -f");
    expect(p).toContain("keeps running on the host");
    expect(p).not.toContain("--service-type=oneshot sh -c '<work>' &&");
  });
});
