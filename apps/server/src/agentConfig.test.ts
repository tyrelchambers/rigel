import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_CONFIG_KEY, emptyUserConfigData } from "@rigel/k8s/src/userConfig";
import {
  __setClusterConfigIO,
  __useFakeClusterConfig,
  __resetClusterConfigCache,
  type FakeClusterConfig,
} from "./clusterConfigStore";
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
let fake: FakeClusterConfig;
/** Config is per cluster, so every call names the context it belongs to. */
const CTX = "test-cluster";
const ORIG_HOME = process.env.HOME;
const ORIG_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const ORIG_CODEX_HOME = process.env.CODEX_HOME;
const ORIG_XDG = process.env.XDG_DATA_HOME;

/** Seed the cluster's stored agents config (bypasses setAgentAuth's guards). */
function writeRawConfig(cfg: unknown): void {
  fake.secrets.set(CTX, { ...emptyUserConfigData(), [AGENTS_CONFIG_KEY]: JSON.stringify(cfg) });
  __resetClusterConfigCache();
}

/** The agents config as the cluster currently holds it. */
function storedAgents(): { activeAgentId?: string; agents?: Record<string, { apiKey?: string }> } {
  return JSON.parse(fake.secrets.get(CTX)?.[AGENTS_CONFIG_KEY] || "{}");
}

beforeEach(async () => {
  fake = __useFakeClusterConfig();
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
  __setClusterConfigIO(null);
  __resetClusterConfigCache();
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
    const v = await agentsView(CTX);
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
    await setAgentAuth("claude", { authMethod: "apiKey", secret: "sk-test-123" }, CTX);
    __setInstalledProbe(() => false);
    expect(await agentConnection("claude", CTX)).toBe("notInstalled");
  });

  it("only reports connected when installed AND credentialed", async () => {
    await setAgentAuth("claude", { authMethod: "apiKey", secret: "sk-test-123" }, CTX);
    __setInstalledProbe(() => true);
    expect(await agentConnection("claude", CTX)).toBe("connected");
  });

  it("probes the installed state per agent id (claude present, codex absent)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-xyz"; // claude credentialed
    __setInstalledProbe((bin) => bin === "claude");
    expect(await agentConnection("claude", CTX)).toBe("connected");
    expect(await agentConnection("codex", CTX)).toBe("notInstalled");
  });
});

describe("setAgentAuth (claude, apiKey)", () => {
  it("stores the key in the cluster's Secret and reports connected", async () => {
    const view = await setAgentAuth("claude", { authMethod: "apiKey", secret: "sk-test-123" }, CTX);
    expect(view.authMethod).toBe("apiKey");
    expect(view.connection).toBe("connected");

    expect(storedAgents().agents?.claude).toEqual({ authMethod: "apiKey", apiKey: "sk-test-123" });
    expect(await claudeAuthEnv(CTX)).toEqual({ ANTHROPIC_API_KEY: "sk-test-123" });
  });

  it("writes nothing to disk", async () => {
    await setAgentAuth("claude", { authMethod: "apiKey", secret: "sk-test-123" }, CTX);
    await expect(readFile(join(home, ".claude", "rigel-agents.json"), "utf8")).rejects.toThrow();
  });
});

describe("setAgentAuth (claude, subscription)", () => {
  it("clears any api key and falls back to the oauth env token", async () => {
    await setAgentAuth("claude", { authMethod: "apiKey", secret: "sk-test-123" }, CTX);
    const view = await setAgentAuth("claude", { authMethod: "subscription", secret: "" }, CTX);
    expect(view.authMethod).toBe("subscription");
    // no token anywhere → installed but not signed in
    expect(await agentConnection("claude", CTX)).toBe("notSignedIn");
    // an env oauth token makes it connected and is what we launch with
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-xyz";
    expect(await agentConnection("claude", CTX)).toBe("connected");
    expect(await claudeAuthEnv(CTX)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-xyz" });
  });
});

describe("setAgentAuth (unknown agent)", () => {
  it("rejects an unknown agent id", async () => {
    // @ts-expect-error intentionally passing an invalid id
    await expect(setAgentAuth("bogus", { authMethod: "apiKey", secret: "x" }, CTX)).rejects.toThrow(
      /unknown agent/,
    );
  });
});

describe("setAgentAuth (gemini, apiKey)", () => {
  it("stores the key and reports connected; geminiAuthEnv injects GEMINI_API_KEY", async () => {
    const view = await setAgentAuth("gemini", { authMethod: "apiKey", secret: "g-key-123" }, CTX);
    expect(view.authMethod).toBe("apiKey");
    expect(view.connection).toBe("connected");
    expect(await geminiAuthEnv(CTX)).toEqual({ GEMINI_API_KEY: "g-key-123" });
  });
});

describe("codexAuthEnv", () => {
  it("returns CODEX_API_KEY when codex is configured with an api key", async () => {
    writeRawConfig({
      activeAgentId: "claude",
      agents: { codex: { authMethod: "apiKey", apiKey: "sk-codex-123" } },
    });
    expect(await codexAuthEnv(CTX)).toEqual({ CODEX_API_KEY: "sk-codex-123" });
  });

  it("returns {} on subscription (codex reads its own auth.json)", async () => {
    writeRawConfig({
      activeAgentId: "claude",
      agents: { codex: { authMethod: "subscription" } },
    });
    expect(await codexAuthEnv(CTX)).toEqual({});
  });

  it("returns {} when there is no codex entry", async () => {
    expect(await codexAuthEnv(CTX)).toEqual({});
  });

  it("round-trips a key set via setAgentAuth", async () => {
    const view = await setAgentAuth("codex", { authMethod: "apiKey", secret: "sk-codex-rt" }, CTX);
    expect(view.connection).toBe("connected");
    expect(storedAgents().agents?.codex?.apiKey).toBe("sk-codex-rt");
    expect(await codexAuthEnv(CTX)).toEqual({ CODEX_API_KEY: "sk-codex-rt" });
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
    writeRawConfig({
      activeAgentId: "claude",
      agents: { gemini: { authMethod: "apiKey", apiKey: "g-key-456" } },
    });
    expect(await geminiAuthEnv(CTX)).toEqual({ GEMINI_API_KEY: "g-key-456" });
  });

  it("returns {} on subscription (gemini reads its own oauth_creds.json)", async () => {
    writeRawConfig({
      activeAgentId: "claude",
      agents: { gemini: { authMethod: "subscription" } },
    });
    expect(await geminiAuthEnv(CTX)).toEqual({});
  });

  it("returns {} when there is no gemini entry", async () => {
    expect(await geminiAuthEnv(CTX)).toEqual({});
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
    writeRawConfig({
      activeAgentId: "claude",
      agents: { gemini: { authMethod: "subscription" } },
    });
    expect(await agentConnection("gemini", CTX)).toBe("notSignedIn");
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(join(home, ".gemini", "oauth_creds.json"), "{}", "utf8");
    expect(await agentConnection("gemini", CTX)).toBe("connected");
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
      expect(await agentConnection("opencode", CTX)).toBe("notSignedIn");

      const ocDir = join(dataHome, "opencode");
      await mkdir(ocDir, { recursive: true });
      await writeFile(
        join(ocDir, "auth.json"),
        JSON.stringify({ openai: { type: "api", key: "k" } }),
        "utf8",
      );
      expect(await agentConnection("opencode", CTX)).toBe("connected");
    } finally {
      await rm(dataHome, { recursive: true, force: true });
    }
  });
});

describe("setActiveAgent", () => {
  it("persists the active agent for an available agent", async () => {
    await setActiveAgent("claude", CTX);
    expect(storedAgents().activeAgentId).toBe("claude");
    expect((await agentsView(CTX)).activeAgentId).toBe("claude");
  });

  it("persists codex as the active agent (codex is available)", async () => {
    const view = await setActiveAgent("codex", CTX);
    expect(view.activeAgentId).toBe("codex");
    expect(storedAgents().activeAgentId).toBe("codex");
    expect((await agentsView(CTX)).activeAgentId).toBe("codex");
  });

  it("persists gemini as the active agent (gemini is available)", async () => {
    const view = await setActiveAgent("gemini", CTX);
    expect(view.activeAgentId).toBe("gemini");
    expect(storedAgents().activeAgentId).toBe("gemini");
  });

  it("rejects an unknown agent", async () => {
    // @ts-expect-error intentionally passing an invalid id
    await expect(setActiveAgent("bogus", CTX)).rejects.toThrow(/unknown agent/);
  });
});

describe("no cluster", () => {
  it("reports the unreachable cluster instead of an empty config", async () => {
    fake.reachable = false;
    const v = await agentsView(CTX);
    expect(v.cluster.state).toBe("unavailable");
    expect(v.cluster.context).toBe(CTX);
    expect(v.cluster.message).toMatch(/connection to the server/);
  });

  it("refuses to save, rather than saving nowhere", async () => {
    fake.reachable = false;
    await expect(
      setAgentAuth("claude", { authMethod: "apiKey", secret: "sk-nope" }, CTX),
    ).rejects.toThrow(/no cluster to save to/);
    await expect(setActiveAgent("codex", CTX)).rejects.toThrow(/no cluster to save to/);
  });
});

describe("per-cluster isolation", () => {
  it("a key saved against one context is not visible from another", async () => {
    await setAgentAuth("gemini", { authMethod: "apiKey", secret: "g-one" }, CTX);
    expect(await geminiAuthEnv(CTX)).toEqual({ GEMINI_API_KEY: "g-one" });
    expect(await geminiAuthEnv("other-cluster")).toEqual({});
  });
});
