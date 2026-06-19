import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentsView,
  agentConnection,
  setAgentAuth,
  claudeAuthEnv,
} from "./agentConfig";

let home: string;
const ORIG_HOME = process.env.HOME;
const ORIG_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rigel-agents-"));
  process.env.HOME = home;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  await mkdir(join(home, ".claude"), { recursive: true });
});

afterEach(async () => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_TOKEN === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG_TOKEN;
  await rm(home, { recursive: true, force: true });
});

describe("agentsView", () => {
  it("defaults active=claude and marks others coming soon", async () => {
    const v = await agentsView();
    expect(v.activeAgentId).toBe("claude");
    expect(v.agents.find((a) => a.id === "claude")?.connection).toBe("notConnected");
    expect(v.agents.find((a) => a.id === "codex")?.connection).toBe("comingSoon");
  });
});

describe("setAgentAuth (claude, apiKey)", () => {
  it("stores the key 0600 and reports connected", async () => {
    const view = await setAgentAuth("claude", { authMethod: "apiKey", secret: "sk-test-123" });
    expect(view.authMethod).toBe("apiKey");
    expect(view.connection).toBe("connected");

    const file = join(home, ".claude", "helmsman-agents.json");
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.agents.claude).toEqual({ authMethod: "apiKey", apiKey: "sk-test-123" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    expect(await claudeAuthEnv()).toEqual({ ANTHROPIC_API_KEY: "sk-test-123" });
  });
});

describe("setAgentAuth (claude, subscription)", () => {
  it("clears any api key and falls back to the oauth env token", async () => {
    await setAgentAuth("claude", { authMethod: "apiKey", secret: "sk-test-123" });
    const view = await setAgentAuth("claude", { authMethod: "subscription", secret: "" });
    expect(view.authMethod).toBe("subscription");
    // no token anywhere → not connected
    expect(await agentConnection("claude")).toBe("notConnected");
    // an env oauth token makes it connected and is what we launch with
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-xyz";
    expect(await agentConnection("claude")).toBe("connected");
    expect(await claudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-xyz" });
  });
});

describe("setAgentAuth (coming soon)", () => {
  it("rejects a not-available agent", async () => {
    await expect(setAgentAuth("codex", { authMethod: "apiKey", secret: "x" })).rejects.toThrow(
      /not available/,
    );
  });
});
