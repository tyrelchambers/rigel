import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentsView,
  agentConnection,
  setAgentAuth,
  setActiveAgent,
  claudeAuthEnv,
  codexAuthEnv,
  codexSubscriptionConnected,
} from "./agentConfig";

let home: string;
const ORIG_HOME = process.env.HOME;
const ORIG_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const ORIG_CODEX_HOME = process.env.CODEX_HOME;

/** Write rigel-agents.json directly (bypasses setAgentAuth's comingSoon guard). */
async function writeRawConfig(cfg: unknown): Promise<void> {
  await writeFile(join(home, ".claude", "rigel-agents.json"), JSON.stringify(cfg), "utf8");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rigel-agents-"));
  process.env.HOME = home;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CODEX_HOME;
  await mkdir(join(home, ".claude"), { recursive: true });
});

afterEach(async () => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_TOKEN === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG_TOKEN;
  if (ORIG_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIG_CODEX_HOME;
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

    const file = join(home, ".claude", "rigel-agents.json");
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

describe("codexAuthEnv", () => {
  it("returns CODEX_API_KEY when codex is configured with an api key", async () => {
    await writeRawConfig({
      activeAgentId: "claude",
      agents: { codex: { authMethod: "apiKey", apiKey: "sk-codex-123" } },
    });
    expect(await codexAuthEnv()).toEqual({ CODEX_API_KEY: "sk-codex-123" });
  });

  it("returns {} on subscription (codex reads its own auth.json)", async () => {
    await writeRawConfig({
      activeAgentId: "claude",
      agents: { codex: { authMethod: "subscription" } },
    });
    expect(await codexAuthEnv()).toEqual({});
  });

  it("returns {} when there is no codex entry", async () => {
    expect(await codexAuthEnv()).toEqual({});
  });
});

describe("codexSubscriptionConnected", () => {
  it("is false when auth.json is absent and true when present", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "rigel-codex-"));
    process.env.CODEX_HOME = codexHome;
    try {
      expect(await codexSubscriptionConnected()).toBe(false);
      await writeFile(join(codexHome, "auth.json"), "{}", "utf8");
      expect(await codexSubscriptionConnected()).toBe(true);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

describe("setActiveAgent", () => {
  it("persists the active agent for an available agent", async () => {
    await setActiveAgent("claude");
    const file = join(home, ".claude", "rigel-agents.json");
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.activeAgentId).toBe("claude");
    expect((await agentsView()).activeAgentId).toBe("claude");
  });

  it("rejects a coming-soon agent", async () => {
    await expect(setActiveAgent("codex")).rejects.toThrow(/not available/);
  });

  it("rejects an unknown agent", async () => {
    // @ts-expect-error intentionally passing an invalid id
    await expect(setActiveAgent("bogus")).rejects.toThrow(/unknown agent/);
  });
});
