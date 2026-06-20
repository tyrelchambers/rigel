// Per-agent auth config, persisted to ~/.claude/rigel-agents.json (0600).
//
// Claude is special: its SUBSCRIPTION token keeps living in the existing
// rigel-oauth-token file (env CLAUDE_CODE_OAUTH_TOKEN still wins), reusing
// chatConfig.ts. This file only stores the chosen auth method + any API keys.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { effectiveClaudeToken, setClaudeToken } from "./chatConfig";
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
    return { ANTHROPIC_API_KEY: entry.apiKey };
  }
  const token = await effectiveClaudeToken();
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
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
      cfg.agents.claude = { authMethod: "apiKey", apiKey: secret || undefined };
    } else {
      cfg.agents.claude = { authMethod: "subscription" };
      await setClaudeToken(secret); // persists/clears the OAuth token file
    }
  } else {
    cfg.agents[id] = {
      authMethod: input.authMethod,
      apiKey: input.authMethod === "apiKey" ? secret || undefined : undefined,
    };
  }
  await writeAgentsConfig(cfg);
  const view = (await agentsView()).agents.find((a) => a.id === id);
  if (!view) throw new Error(`agent vanished: ${id}`);
  return view;
}
