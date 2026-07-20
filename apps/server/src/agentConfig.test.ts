import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentsView,
  agentConnection,
  __setInstalledProbe,
  setAgentAuth,
  setActiveAgent,
  claudeAuthEnv,
  codexAuthEnv,
  codexSubscriptionConnected,
  geminiAuthEnv,
  geminiConnected,
  opencodeAuthEnv,
  opencodeConnected,
} from "./agentConfig";

let home: string;
const ORIG_HOME = process.env.HOME;
const ORIG_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const ORIG_CODEX_HOME = process.env.CODEX_HOME;
const ORIG_XDG = process.env.XDG_DATA_HOME;

/** Write rigel-agents.json directly (bypasses setAgentAuth's comingSoon guard). */
async function writeRawConfig(cfg: unknown): Promise<void> {
  await writeFile(join(home, ".claude", "rigel-agents.json"), JSON.stringify(cfg), "utf8");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rigel-agents-"));
  process.env.HOME = home;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CODEX_HOME;
  delete process.env.XDG_DATA_HOME;
  await mkdir(join(home, ".claude"), { recursive: true });
  // Most tests exercise the CREDENTIAL dimension, so treat every CLI as installed;
  // the install dimension has its own describe block that drives the probe directly.
  __setInstalledProbe(() => true);
});

afterEach(async () => {
  __setInstalledProbe(null);
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_TOKEN === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIG_TOKEN;
  if (ORIG_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIG_CODEX_HOME;
  if (ORIG_XDG === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = ORIG_XDG;
  await rm(home, { recursive: true, force: true });
});

describe("agentsView", () => {
  it("defaults active=claude; all listed agents are available (none coming soon)", async () => {
    const v = await agentsView();
    expect(v.activeAgentId).toBe("claude");
    // Installed (forced) but no auth on a fresh temp HOME → notSignedIn.
    expect(v.agents.find((a) => a.id === "claude")?.connection).toBe("notSignedIn");
    expect(v.agents.find((a) => a.id === "gemini")?.connection).toBe("notSignedIn");
    // None of the listed agents are coming soon anymore.
    expect(v.agents.every((a) => a.connection !== "comingSoon")).toBe(true);
  });
});

describe("agentConnection install gating", () => {
  it("reports notInstalled when the CLI is not on PATH, even with a stored credential", async () => {
    // Credential present (Rigel-stored API key) but the CLI is missing.
    await setAgentAuth("claude", { authMethod: "apiKey", secret: "sk-test-123" });
    __setInstalledProbe(() => false);
    expect(await agentConnection("claude")).toBe("notInstalled");
  });

  it("only reports connected when installed AND credentialed", async () => {
    await setAgentAuth("claude", { authMethod: "apiKey", secret: "sk-test-123" });
    __setInstalledProbe(() => true);
    expect(await agentConnection("claude")).toBe("connected");
  });

  it("probes the installed state per agent id (claude present, codex absent)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-xyz"; // claude credentialed
    __setInstalledProbe((bin) => bin === "claude");
    expect(await agentConnection("claude")).toBe("connected");
    expect(await agentConnection("codex")).toBe("notInstalled");
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
    // no token anywhere → installed but not signed in
    expect(await agentConnection("claude")).toBe("notSignedIn");
    // an env oauth token makes it connected and is what we launch with
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-xyz";
    expect(await agentConnection("claude")).toBe("connected");
    expect(await claudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-xyz" });
  });
});

describe("setAgentAuth (unknown agent)", () => {
  it("rejects an unknown agent id", async () => {
    // @ts-expect-error intentionally passing an invalid id
    await expect(setAgentAuth("bogus", { authMethod: "apiKey", secret: "x" })).rejects.toThrow(
      /unknown agent/,
    );
  });
});

describe("setAgentAuth (gemini, apiKey)", () => {
  it("stores the key and reports connected; geminiAuthEnv injects GEMINI_API_KEY", async () => {
    const view = await setAgentAuth("gemini", { authMethod: "apiKey", secret: "g-key-123" });
    expect(view.authMethod).toBe("apiKey");
    expect(view.connection).toBe("connected");
    expect(await geminiAuthEnv()).toEqual({ GEMINI_API_KEY: "g-key-123" });
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

  it("round-trips a key set via setAgentAuth (plaintext fallback in tests)", async () => {
    const view = await setAgentAuth("codex", { authMethod: "apiKey", secret: "sk-codex-rt" });
    expect(view.connection).toBe("connected");
    // In the test env (no keychain) encryptSecret is a passthrough, so the stored
    // key is plaintext and decryptSecret returns it unchanged.
    const parsed = JSON.parse(await readFile(join(home, ".claude", "rigel-agents.json"), "utf8"));
    expect(parsed.agents.codex.apiKey).toBe("sk-codex-rt");
    expect(await codexAuthEnv()).toEqual({ CODEX_API_KEY: "sk-codex-rt" });
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

describe("geminiAuthEnv", () => {
  it("returns GEMINI_API_KEY when gemini is configured with an api key", async () => {
    await writeRawConfig({
      activeAgentId: "claude",
      agents: { gemini: { authMethod: "apiKey", apiKey: "g-key-456" } },
    });
    expect(await geminiAuthEnv()).toEqual({ GEMINI_API_KEY: "g-key-456" });
  });

  it("returns {} on subscription (gemini reads its own oauth_creds.json)", async () => {
    await writeRawConfig({
      activeAgentId: "claude",
      agents: { gemini: { authMethod: "subscription" } },
    });
    expect(await geminiAuthEnv()).toEqual({});
  });

  it("returns {} when there is no gemini entry", async () => {
    expect(await geminiAuthEnv()).toEqual({});
  });
});

describe("geminiConnected", () => {
  it("is false when oauth_creds.json is absent and true when present", async () => {
    // geminiConnected reads ~/.gemini/oauth_creds.json under the temp HOME.
    expect(await geminiConnected()).toBe(false);
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(join(home, ".gemini", "oauth_creds.json"), "{}", "utf8");
    expect(await geminiConnected()).toBe(true);
  });

  it("agentConnection('gemini') tracks the subscription login when on subscription auth", async () => {
    await writeRawConfig({
      activeAgentId: "claude",
      agents: { gemini: { authMethod: "subscription" } },
    });
    expect(await agentConnection("gemini")).toBe("notSignedIn");
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(join(home, ".gemini", "oauth_creds.json"), "{}", "utf8");
    expect(await agentConnection("gemini")).toBe("connected");
  });
});

describe("opencodeAuthEnv", () => {
  it("always returns {} (OpenCode is login-managed; nothing to inject)", async () => {
    expect(await opencodeAuthEnv()).toEqual({});
  });
});

describe("opencodeConnected", () => {
  it("is false with no auth.json, true with ≥1 credential, false for empty {}", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "rigel-xdg-"));
    process.env.XDG_DATA_HOME = dataHome;
    try {
      // No file yet.
      expect(await opencodeConnected()).toBe(false);

      const ocDir = join(dataHome, "opencode");
      await mkdir(ocDir, { recursive: true });
      // Empty object → not connected (no providers logged in).
      await writeFile(join(ocDir, "auth.json"), "{}", "utf8");
      expect(await opencodeConnected()).toBe(false);

      // A real credential → connected.
      await writeFile(
        join(ocDir, "auth.json"),
        JSON.stringify({ anthropic: { type: "oauth", access: "tok" } }),
        "utf8",
      );
      expect(await opencodeConnected()).toBe(true);
    } finally {
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  it("agentConnection('opencode') tracks the login (available + login-only)", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "rigel-xdg-"));
    process.env.XDG_DATA_HOME = dataHome;
    try {
      // No login → notSignedIn (and NOT comingSoon — opencode is available now).
      expect(await agentConnection("opencode")).toBe("notSignedIn");

      const ocDir = join(dataHome, "opencode");
      await mkdir(ocDir, { recursive: true });
      await writeFile(
        join(ocDir, "auth.json"),
        JSON.stringify({ openai: { type: "api", key: "k" } }),
        "utf8",
      );
      expect(await agentConnection("opencode")).toBe("connected");
    } finally {
      await rm(dataHome, { recursive: true, force: true });
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

  it("persists codex as the active agent (codex is available)", async () => {
    const view = await setActiveAgent("codex");
    expect(view.activeAgentId).toBe("codex");
    const file = join(home, ".claude", "rigel-agents.json");
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.activeAgentId).toBe("codex");
    expect((await agentsView()).activeAgentId).toBe("codex");
  });

  it("persists gemini as the active agent (gemini is available)", async () => {
    const view = await setActiveAgent("gemini");
    expect(view.activeAgentId).toBe("gemini");
    const file = join(home, ".claude", "rigel-agents.json");
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.activeAgentId).toBe("gemini");
  });

  it("rejects an unknown agent", async () => {
    // @ts-expect-error intentionally passing an invalid id
    await expect(setActiveAgent("bogus")).rejects.toThrow(/unknown agent/);
  });
});
