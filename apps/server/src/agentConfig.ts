// Per-agent auth config, persisted to ~/.claude/rigel-agents.json (0600).
//
// Claude is special: its SUBSCRIPTION token keeps living in the existing
// rigel-oauth-token file (env CLAUDE_CODE_OAUTH_TOKEN still wins), reusing
// chatConfig.ts. This file only stores the chosen auth method + any API keys.
import { homedir } from "node:os";
import { join } from "node:path";
import { access, readFile, writeFile } from "node:fs/promises";
import { effectiveClaudeToken, setClaudeToken } from "./chatConfig";
import { decryptSecret, encryptSecret } from "./secretStore";
import {
  getAgent,
  listAgents,
  type AgentAuthMethod,
  type AgentId,
} from "./agentRegistry";

interface AgentAuthEntry {
  authMethod: AgentAuthMethod;
  apiKey?: string;
}
interface AgentsConfig {
  activeAgentId: AgentId;
  agents: Partial<Record<AgentId, AgentAuthEntry>>;
}

function configPath(): string {
  return join(homedir(), ".claude", "rigel-agents.json");
}

export async function readAgentsConfig(): Promise<AgentsConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8")) as Partial<AgentsConfig>;
    return { activeAgentId: parsed.activeAgentId ?? "claude", agents: parsed.agents ?? {} };
  } catch {
    return { activeAgentId: "claude", agents: {} };
  }
}

async function writeAgentsConfig(cfg: AgentsConfig): Promise<void> {
  await writeFile(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function authMethodFor(cfg: AgentsConfig, id: AgentId): AgentAuthMethod {
  return cfg.agents[id]?.authMethod ?? getAgent(id)?.authMethods[0] ?? "subscription";
}

/** Env vars to launch Claude with, per its active auth method. */
export async function claudeAuthEnv(): Promise<Record<string, string>> {
  const cfg = await readAgentsConfig();
  const entry = cfg.agents.claude;
  if (entry?.authMethod === "apiKey" && entry.apiKey) {
    const key = decryptSecret(entry.apiKey);
    if (key) return { ANTHROPIC_API_KEY: key };
  }
  const token = await effectiveClaudeToken();
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
}

/** Env vars to launch Codex with, per its active auth method. */
export async function codexAuthEnv(): Promise<Record<string, string>> {
  const cfg = await readAgentsConfig();
  const entry = cfg.agents.codex;
  if (entry?.authMethod === "apiKey" && entry.apiKey) {
    // CODEX_API_KEY (not OPENAI_API_KEY): `codex exec` builds its session with
    // enable_codex_api_key_env=true (codex-rs/exec/src/lib.rs), so it reads the
    // key from CODEX_API_KEY. OPENAI_API_KEY is only consulted by the TUI/realtime
    // paths, never by headless exec. Verified against the codex source.
    const key = decryptSecret(entry.apiKey);
    if (key) return { CODEX_API_KEY: key };
  }
  // Subscription: Codex reads its own ~/.codex/auth.json; nothing to inject.
  return {};
}

/** A ChatGPT-subscription login exists iff Codex's auth.json is on disk. */
export async function codexSubscriptionConnected(): Promise<boolean> {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  try {
    await access(join(home, "auth.json"));
    return true;
  } catch {
    return false;
  }
}

/** Env vars to launch OpenCode with. OpenCode is login-managed: `opencode providers
 * login` stores creds in its own auth.json, so there is no Rigel-managed key to
 * inject — always {}. (Mirrors codexAuthEnv's subscription branch.) */
export async function opencodeAuthEnv(): Promise<Record<string, string>> {
  return {};
}

/**
 * An OpenCode login exists iff its auth.json is on disk AND parses to a non-empty
 * object (≥1 credential). Login lives at `$XDG_DATA_HOME/opencode/auth.json`, or
 * `~/.local/share/opencode/auth.json` when XDG_DATA_HOME is unset. Mirrors
 * codexSubscriptionConnected, but also reads the file so an empty `{}` (no providers
 * logged in) doesn't count as connected.
 */
export async function opencodeConnected(): Promise<boolean> {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  try {
    const parsed = JSON.parse(await readFile(join(dataHome, "opencode", "auth.json"), "utf8"));
    return !!parsed && typeof parsed === "object" && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

export type AgentConnection = "connected" | "notConnected" | "comingSoon";

export async function agentConnection(id: AgentId): Promise<AgentConnection> {
  const desc = getAgent(id);
  if (!desc || desc.status === "comingSoon") return "comingSoon";
  const cfg = await readAgentsConfig();
  if (id === "claude") {
    if (authMethodFor(cfg, "claude") === "apiKey") {
      return cfg.agents.claude?.apiKey ? "connected" : "notConnected";
    }
    return (await effectiveClaudeToken()) ? "connected" : "notConnected";
  }
  if (id === "codex") {
    if (authMethodFor(cfg, "codex") === "apiKey") {
      return cfg.agents.codex?.apiKey ? "connected" : "notConnected";
    }
    return (await codexSubscriptionConnected()) ? "connected" : "notConnected";
  }
  if (id === "opencode") {
    // OpenCode is login-managed only (no Rigel-stored key); connected iff its own
    // auth.json holds ≥1 credential.
    return (await opencodeConnected()) ? "connected" : "notConnected";
  }
  return cfg.agents[id]?.apiKey ? "connected" : "notConnected";
}

export interface AgentView {
  id: AgentId;
  label: string;
  vendor: string;
  status: "available" | "comingSoon";
  connection: AgentConnection;
  authMethods: AgentAuthMethod[];
  authMethod: AgentAuthMethod;
  installUrl: string;
  installLabel: string;
}
export interface AgentsResponse {
  activeAgentId: AgentId;
  agents: AgentView[];
}

export async function agentsView(): Promise<AgentsResponse> {
  const cfg = await readAgentsConfig();
  const agents: AgentView[] = [];
  for (const d of listAgents()) {
    agents.push({
      id: d.id,
      label: d.label,
      vendor: d.vendor,
      status: d.status,
      connection: await agentConnection(d.id),
      authMethods: d.authMethods,
      authMethod: authMethodFor(cfg, d.id),
      installUrl: d.installUrl,
      installLabel: d.installLabel,
    });
  }
  return { activeAgentId: cfg.activeAgentId, agents };
}

export interface SetAgentAuthInput {
  authMethod: AgentAuthMethod;
  secret?: string;
}

export async function setAgentAuth(id: AgentId, input: SetAgentAuthInput): Promise<AgentView> {
  const desc = getAgent(id);
  if (!desc) throw new Error(`unknown agent: ${id}`);
  if (desc.status === "comingSoon") throw new Error(`agent not available: ${id}`);

  const cfg = await readAgentsConfig();
  const secret = (input.secret ?? "").trim();

  if (id === "claude") {
    if (input.authMethod === "apiKey") {
      cfg.agents.claude = { authMethod: "apiKey", apiKey: secret ? encryptSecret(secret) : undefined };
    } else {
      cfg.agents.claude = { authMethod: "subscription" };
      await setClaudeToken(secret); // persists/clears the OAuth token file
    }
  } else {
    cfg.agents[id] = {
      authMethod: input.authMethod,
      apiKey: input.authMethod === "apiKey" && secret ? encryptSecret(secret) : undefined,
    };
  }
  await writeAgentsConfig(cfg);
  const view = (await agentsView()).agents.find((a) => a.id === id);
  if (!view) throw new Error(`agent vanished: ${id}`);
  return view;
}

/** Switch the active agent. Only an available agent can be activated. */
export async function setActiveAgent(id: AgentId): Promise<AgentsResponse> {
  const desc = getAgent(id);
  if (!desc) throw new Error(`unknown agent: ${id}`);
  if (desc.status === "comingSoon") throw new Error(`agent not available: ${id}`);

  const cfg = await readAgentsConfig();
  cfg.activeAgentId = id;
  await writeAgentsConfig(cfg);
  return await agentsView();
}
