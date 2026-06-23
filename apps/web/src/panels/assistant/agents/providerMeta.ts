// Pure provider metadata the Assistant Agents UI owns: the provider id list, the
// role defaults, and the provider→credential-key mapping. Vendor names, labels,
// and auth-method copy come from useAgents() at render time — this module only
// holds what the server does not surface.
import type { AgentId, AssistantCredentials, AssistantLimits, AssistantRoleSelection } from "@/lib/api";

/** The four providers, in display order. Mirrors the chat's AgentId set. */
export const PROVIDER_IDS: AgentId[] = ["claude", "codex", "gemini", "opencode"];

/** Out-of-box defaults — keep the fresh-install experience unchanged. */
export const DEFAULT_WORKER: AssistantRoleSelection = {
  provider: "claude",
  model: "claude-sonnet-4-6",
  effort: "high",
};
export const DEFAULT_SUPERVISOR: AssistantRoleSelection = {
  provider: "claude",
  model: "claude-opus-4-8",
  effort: "high",
};

/** Out-of-box operational limits — mirrors the server's DEFAULT_INSTALL_CONFIG (and
 *  the agent's Config defaults), so the Operational limits form shows the real values
 *  the agent uses rather than blanks when assistant-config hasn't overridden them. */
export const DEFAULT_LIMITS: AssistantLimits = {
  pollIntervalMs: 30000,
  maxPerResourcePerHour: 3,
  maxPerNight: 20,
  maxAttemptsPerIncident: 3,
  confirmPolls: 2,
  namespaces: [],
};

/** Every credential Secret key a provider can authenticate with. */
const KEYS_FOR: Record<AgentId, (keyof AssistantCredentials)[]> = {
  claude: ["claudeToken", "anthropicApiKey"],
  codex: ["codexApiKey", "codexAuthContent"],
  gemini: ["geminiApiKey"],
  opencode: ["opencodeApiKey", "opencodeAuthContent"],
};

/** The PRIMARY credential key a pasted value for this provider writes to. */
export function credentialKeyFor(id: AgentId): keyof AssistantCredentials {
  return KEYS_FOR[id][0]!;
}

/** Reasoning effort applies only to Claude-family providers. */
export function isClaudeFamily(id: AgentId | string): boolean {
  return id === "claude";
}

/** True when at least one of the provider's credential keys has a non-empty value. */
export function credentialReady(id: AgentId, creds: AssistantCredentials | undefined): boolean {
  if (!creds) return false;
  return KEYS_FOR[id].some((k) => {
    const v = creds[k];
    return typeof v === "string" && v.trim() !== "";
  });
}

// ---------------------------------------------------------------------------
// Auth guidance — how each provider authenticates IN-CLUSTER, and the step-by-step
// help shown in the per-row help modal. Mirrors the real Secret keys a provider
// accepts (KEYS_FOR): Claude and OpenCode take a subscription OR an API key; Codex
// and Gemini take an API key. This is the single source for the row's auth-method
// summary and the credential editor's method toggle, so the UI never assumes
// "API key only".
// ---------------------------------------------------------------------------

/** The kind of credential a method stores. */
export type AuthMethodKind = "subscription" | "apiKey";

/** One way to authenticate a provider, plus the guidance to obtain it. */
export interface AuthMethodHelp {
  kind: AuthMethodKind;
  /** Short heading, e.g. "Use your subscription". */
  title: string;
  /** The Secret key a value entered under this method is stored in. */
  key: keyof AssistantCredentials;
  /** Placeholder for the credential input under this method. */
  placeholder: string;
  /** Ordered, plain-language steps. */
  steps: string[];
  /** Optional terminal command to run, shown as a copyable mono line. */
  command?: string;
  /** Optional external link (where to get a key / sign in). */
  link?: { label: string; url: string };
  /** Optional caveat shown under the steps. */
  note?: string;
  /** Marks the preferred method (selected first in the toggle). */
  recommended?: boolean;
}

// Gemini's consumer "Login with Google" needs an interactive browser and has no
// portable/headless token, so the in-cluster assistant can only use an API key.
const GEMINI_KEY_NOTE =
  "Gemini's consumer subscription can't run headless, so the in-cluster assistant uses an API key.";

/** Per-provider auth methods, in display order (recommended first). */
export const PROVIDER_AUTH: Record<AgentId, AuthMethodHelp[]> = {
  claude: [
    {
      kind: "subscription",
      title: "Use your subscription",
      key: "claudeToken",
      placeholder: "Paste your setup token…",
      recommended: true,
      command: "claude setup-token",
      steps: [
        "On your computer, run this in a terminal:",
        "Copy the token it prints, paste it into the field here, then Save.",
      ],
      note: "The token lasts about a year. Re-run the command when it expires.",
    },
    {
      kind: "apiKey",
      title: "Use an API key",
      key: "anthropicApiKey",
      placeholder: "sk-ant-…",
      steps: [
        "Open the Anthropic Console and create an API key.",
        "Paste it into the field here, then Save.",
      ],
      link: { label: "console.anthropic.com", url: "https://console.anthropic.com/settings/keys" },
    },
  ],
  codex: [
    {
      kind: "subscription",
      title: "Use your subscription",
      key: "codexAuthContent",
      placeholder: "Paste your ~/.codex/auth.json contents…",
      recommended: true,
      command: "codex login --device-auth",
      steps: [
        "On your computer, sign in (use `codex login` if you have a browser, or the command above on a headless box):",
        "Copy the contents of ~/.codex/auth.json, paste them into the field here, then Save.",
      ],
      note: "Reuses your ChatGPT plan instead of per-token API billing. Re-paste if the token ever goes stale.",
    },
    {
      kind: "apiKey",
      title: "Use an API key",
      key: "codexApiKey",
      placeholder: "sk-…",
      steps: [
        "Open the OpenAI Platform and create an API key.",
        "Paste it into the field here, then Save.",
      ],
      link: { label: "platform.openai.com", url: "https://platform.openai.com/api-keys" },
      note: "Billed per token at API rates, separate from your ChatGPT plan.",
    },
  ],
  gemini: [
    {
      kind: "apiKey",
      title: "Use an API key",
      key: "geminiApiKey",
      placeholder: "AIza…",
      steps: [
        "Open Google AI Studio and create an API key.",
        "Paste it into the field here, then Save.",
      ],
      link: { label: "aistudio.google.com", url: "https://aistudio.google.com/apikey" },
      note: GEMINI_KEY_NOTE,
    },
  ],
  opencode: [
    {
      kind: "subscription",
      title: "Use your subscription",
      key: "opencodeAuthContent",
      placeholder: "Paste your auth file contents…",
      recommended: true,
      command: "opencode auth login",
      steps: [
        "On your computer, run this and sign in to your provider:",
        "Paste the contents of your OpenCode auth file into the field here, then Save.",
      ],
      note: "Reuses the subscription you already pay for.",
    },
    {
      kind: "apiKey",
      title: "Use an API key",
      key: "opencodeApiKey",
      placeholder: "API key",
      steps: [
        "Create an API key with your OpenCode provider.",
        "Paste it into the field here, then Save.",
      ],
      link: { label: "opencode.ai/docs", url: "https://opencode.ai/docs/" },
    },
  ],
};

/** One-line summary of how a provider authenticates, derived from PROVIDER_AUTH
 *  so the row label never hardcodes "API key". */
export function authMethodSummary(id: AgentId): string {
  const kinds = PROVIDER_AUTH[id].map((m) => m.kind);
  const hasSub = kinds.includes("subscription");
  const hasKey = kinds.includes("apiKey");
  if (hasSub && hasKey) return "Subscription or API key";
  if (hasSub) return "Subscription";
  return "API key";
}
