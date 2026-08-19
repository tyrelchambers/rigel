// Per-agent auth config, stored per cluster in the rigel-user-config Secret.
//
// Claude is special: its SUBSCRIPTION token keeps its own key in that Secret
// (env CLAUDE_CODE_OAUTH_TOKEN still wins), reusing chatConfig.ts. This module
// only stores the chosen auth method + any API keys.
//
// Provider LOGINS (codex/gemini/opencode auth.json) stay on disk: those files
// belong to the vendor CLIs, which read them from the home directory, and Rigel
// neither writes nor moves them.
import { homedir } from "node:os";
import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { commandOnPath } from "@rigel/k8s/src/toolPath";
import { AGENTS_CONFIG_KEY } from "@rigel/k8s/src/userConfig";
import { effectiveClaudeToken, setClaudeToken } from "./chatConfig";
import {
  readUserConfig,
  writeUserConfig,
  type ClusterConfigStatus,
} from "./clusterConfigStore";
import {
  getAgent,
  listAgents,
  type AgentAuthMethod,
  type AgentId,
} from "./agentRegistry";

// The CLI command each agent spawns (argv[0] in the bridges). Equals the id today,
// but named explicitly so the install probe tracks the real binary if that changes.
const AGENT_COMMAND: Record<AgentId, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
};

// Injectable so tests can drive install detection without touching PATH.
let installedProbe: (bin: string) => boolean = commandOnPath;
/** Test seam: override the "is the CLI on PATH?" probe; pass null to reset. */
export function __setInstalledProbe(fn: ((bin: string) => boolean) | null): void {
  installedProbe = fn ?? commandOnPath;
}
/** True when the agent's CLI binary is resolvable on PATH. */
export function agentInstalled(id: AgentId): boolean {
  return installedProbe(AGENT_COMMAND[id]);
}

interface AgentAuthEntry {
  authMethod: AgentAuthMethod;
  apiKey?: string;
}
interface AgentsConfig {
  activeAgentId: AgentId;
  agents: Partial<Record<AgentId, AgentAuthEntry>>;
}

function parseAgentsConfig(blob: string): AgentsConfig {
  try {
    const parsed = JSON.parse(blob || "{}") as Partial<AgentsConfig>;
    return { activeAgentId: parsed.activeAgentId ?? "claude", agents: parsed.agents ?? {} };
  } catch {
    return { activeAgentId: "claude", agents: {} };
  }
}

export async function readAgentsConfig(context: string | null): Promise<AgentsConfig> {
  return parseAgentsConfig((await readUserConfig(context)).data[AGENTS_CONFIG_KEY]);
}

/** Apply `edit` to the stored config inside the write queue, so a concurrent
 *  save to another agent's entry cannot be lost. */
async function updateAgentsConfig(
  context: string | null,
  edit: (cfg: AgentsConfig) => void,
): Promise<void> {
  await writeUserConfig(context, (current) => {
    const cfg = parseAgentsConfig(current[AGENTS_CONFIG_KEY]);
    edit(cfg);
    return { [AGENTS_CONFIG_KEY]: JSON.stringify(cfg) };
  });
}

function authMethodFor(cfg: AgentsConfig, id: AgentId): AgentAuthMethod {
  return cfg.agents[id]?.authMethod ?? getAgent(id)?.authMethods[0] ?? "subscription";
}

/** Env vars to launch Claude with, per its active auth method. */
export async function claudeAuthEnv(context: string | null): Promise<Record<string, string>> {
  const cfg = await readAgentsConfig(context);
  const entry = cfg.agents.claude;
  if (entry?.authMethod === "apiKey" && entry.apiKey) {
    return { ANTHROPIC_API_KEY: entry.apiKey };
  }
  const token = await effectiveClaudeToken(context);
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
}

/** Env vars to launch Codex with, per its active auth method. */
export async function codexAuthEnv(context: string | null): Promise<Record<string, string>> {
  const cfg = await readAgentsConfig(context);
  const entry = cfg.agents.codex;
  if (entry?.authMethod === "apiKey" && entry.apiKey) {
    // CODEX_API_KEY (not OPENAI_API_KEY): `codex exec` builds its session with
    // enable_codex_api_key_env=true (codex-rs/exec/src/lib.rs), so it reads the
    // key from CODEX_API_KEY. OPENAI_API_KEY is only consulted by the TUI/realtime
    // paths, never by headless exec. Verified against the codex source.
    return { CODEX_API_KEY: entry.apiKey };
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

/** Env vars to launch Gemini with, per its active auth method. */
export async function geminiAuthEnv(context: string | null): Promise<Record<string, string>> {
  const cfg = await readAgentsConfig(context);
  const entry = cfg.agents.gemini;
  if (entry?.authMethod === "apiKey" && entry.apiKey) {
    return { GEMINI_API_KEY: entry.apiKey };
  }
  // Subscription: Gemini reads its own ~/.gemini/oauth_creds.json; nothing to inject.
  return {};
}

/** A Google-OAuth login exists iff Gemini's oauth_creds.json is on disk
 * (mirrors codexSubscriptionConnected). */
export async function geminiConnected(): Promise<boolean> {
  try {
    await access(join(homedir(), ".gemini", "oauth_creds.json"));
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

export type AgentConnection = "connected" | "notInstalled" | "notSignedIn" | "comingSoon";

/**
 * Whether the agent has a usable credential — a Rigel-stored API key or a provider
 * login (token/auth file). Distinct from whether the CLI is installed: an agent can
 * have a credential with no CLI (e.g. a stored API key) and vice versa.
 */
async function agentHasCredential(
  id: AgentId,
  cfg: AgentsConfig,
  context: string | null,
): Promise<boolean> {
  if (id === "claude") {
    if (authMethodFor(cfg, "claude") === "apiKey") return !!cfg.agents.claude?.apiKey;
    return !!(await effectiveClaudeToken(context));
  }
  if (id === "codex") {
    if (authMethodFor(cfg, "codex") === "apiKey") return !!cfg.agents.codex?.apiKey;
    return await codexSubscriptionConnected();
  }
  if (id === "opencode") {
    // OpenCode is login-managed only (no Rigel-stored key); credentialed iff its own
    // auth.json holds ≥1 credential.
    return await opencodeConnected();
  }
  if (id === "gemini") {
    if (authMethodFor(cfg, "gemini") === "apiKey") return !!cfg.agents.gemini?.apiKey;
    // Subscription: credentialed iff Gemini's own oauth_creds.json is on disk.
    return await geminiConnected();
  }
  // Exhaustiveness guard: adding a new AgentId without a branch fails the build here.
  return ((_exhaustive: never): boolean => {
    throw new Error(`agentHasCredential: unhandled agent id ${String(_exhaustive)}`);
  })(id);
}

/**
 * Rolls the CLI-installed and has-credential signals into one status. An agent is
 * only "connected" (usable) when its CLI is installed AND it has a credential.
 * Install is the primary gate — you must install before you can sign in — so a
 * missing CLI reports "notInstalled" regardless of any stored credential.
 */
export async function agentConnection(id: AgentId, context: string | null): Promise<AgentConnection> {
  const desc = getAgent(id);
  if (!desc || desc.status === "comingSoon") return "comingSoon";
  if (!agentInstalled(id)) return "notInstalled";
  const cfg = await readAgentsConfig(context);
  return (await agentHasCredential(id, cfg, context)) ? "connected" : "notSignedIn";
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
  /** Which cluster this config belongs to, and whether it could be read. */
  cluster: ClusterConfigStatus;
}

export async function agentsView(context: string | null): Promise<AgentsResponse> {
  const read = await readUserConfig(context);
  const { data, ...cluster } = read;
  const cfg = parseAgentsConfig(data[AGENTS_CONFIG_KEY]);
  const agents: AgentView[] = [];
  for (const d of listAgents()) {
    agents.push({
      id: d.id,
      label: d.label,
      vendor: d.vendor,
      status: d.status,
      connection: await agentConnection(d.id, context),
      authMethods: d.authMethods,
      authMethod: authMethodFor(cfg, d.id),
      installUrl: d.installUrl,
      installLabel: d.installLabel,
    });
  }
  return { activeAgentId: cfg.activeAgentId, agents, cluster };
}

export interface SetAgentAuthInput {
  authMethod: AgentAuthMethod;
  secret?: string;
}

export async function setAgentAuth(
  id: AgentId,
  input: SetAgentAuthInput,
  context: string | null,
): Promise<AgentView> {
  const desc = getAgent(id);
  if (!desc) throw new Error(`unknown agent: ${id}`);
  if (desc.status === "comingSoon") throw new Error(`agent not available: ${id}`);

  const secret = (input.secret ?? "").trim();
  const claudeSubscription = id === "claude" && input.authMethod !== "apiKey";

  await updateAgentsConfig(context, (cfg) => {
    if (claudeSubscription) cfg.agents.claude = { authMethod: "subscription" };
    else {
      cfg.agents[id] = {
        authMethod: input.authMethod,
        apiKey: input.authMethod === "apiKey" && secret ? secret : undefined,
      };
    }
  });
  // Sequenced after the auth-method write so a failure to store the token cannot
  // leave the config claiming a subscription that was never saved.
  if (claudeSubscription) await setClaudeToken(context, secret);

  const view = (await agentsView(context)).agents.find((a) => a.id === id);
  if (!view) throw new Error(`agent vanished: ${id}`);
  return view;
}

/** Switch the active agent. Only an available agent can be activated. */
export async function setActiveAgent(id: AgentId, context: string | null): Promise<AgentsResponse> {
  const desc = getAgent(id);
  if (!desc) throw new Error(`unknown agent: ${id}`);
  if (desc.status === "comingSoon") throw new Error(`agent not available: ${id}`);

  await updateAgentsConfig(context, (cfg) => {
    cfg.activeAgentId = id;
  });
  return await agentsView(context);
}
