# Multi-agent settings modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Pencil-style tabbed settings modal whose Agents tab lets users set up AI agents (Claude live; Codex/Gemini/OpenCode/OpenRouter "Coming soon") via CLI subscription or API key, backed by a server-side agent registry + per-agent config — without rewriting the working Claude path.

**Architecture:** Server gets a pure `agentRegistry` (descriptors) + `agentConfig` (per-agent auth persisted to `~/.claude/rigel-agents.json`, 0600) + a `runAgent` dispatcher that wraps the existing `runClaude`. The Claude env injection moves behind `claudeAuthEnv()` so subscription vs API-key is honored. Web gets `useAgents`/`useSetAgentAuth` hooks, a `SettingsModal` (shadcn Dialog + tab bar), an Agents card-grid + per-agent setup view, opened from a GlobalHeader gear and the NavStrip Settings item. The `/settings` route is removed.

**Tech Stack:** Server: Node + Hono (`Response.json`), vitest. Web: React 19 + Vite + Tailwind v4 + shadcn (`@base-ui/react` Dialog), TanStack Query v5, React Router v7, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-19-multi-agent-settings-modal-design.md`

**Plan note / deliberate divergence from spec:** the spec said *replace* `/api/chat-config`. This plan instead **keeps** `/api/chat-config` + `useChatConfig` (the onboarding "copilot" gate may depend on it) and **adds** `/api/agents` alongside. The Agents tab uses the new surface; the old one can be retired in a later pass once callers are migrated. This is the lower-risk, non-breaking path.

---

## File structure

**Server (new):**
- `apps/server/src/agentRegistry.ts` — agent descriptors + `listAgents`/`getAgent` + shared types. Pure (no heavy imports), so nothing can import-cycle through it.
- `apps/server/src/agentConfig.ts` — per-agent auth config file r/w (0600), `claudeAuthEnv`, `agentConnection`, `agentsView`, `setAgentAuth`.
- `apps/server/src/runAgent.ts` — active-agent dispatcher; wraps `runClaude`.

**Server (modified):**
- `apps/server/src/chatConfig.ts` — make the token-file path lazy (testability); no behavior change.
- `apps/server/src/claudeBridge.ts` — inject auth via `claudeAuthEnv()`.
- `apps/server/src/ws.ts` — `runClaude(...)` → `runAgent(...)`.
- `apps/server/src/index.ts` — add `GET /api/agents` + `POST /api/agents/:id/auth`.

**Web (new):**
- `apps/web/src/panels/settings/SettingsModal.tsx` — Dialog shell + tab bar.
- `apps/web/src/panels/settings/agents/AgentsTab.tsx` — grid ↔ setup view.
- `apps/web/src/panels/settings/agents/AgentCard.tsx` — one card.
- `apps/web/src/panels/settings/agents/AgentSetup.tsx` — per-agent setup.
- `apps/web/src/panels/settings/agents/agentGlyphs.tsx` — per-vendor glyphs.

**Web (modified):**
- `apps/web/src/lib/api.ts` — add `AgentView`/`AgentsResponse` + `useAgents`/`useSetAgentAuth`.
- `apps/web/src/panels/settings/SettingsPanel.tsx` — export `SignalSection`/`SelfHostSection`; remove `CopilotSection` + the default `SettingsPanel`.
- `apps/web/src/App.tsx` — modal open state + render; remove `/settings` route + import.
- `apps/web/src/shell/GlobalHeader.tsx` — add a gear button (`onOpenSettings`).
- `apps/web/src/shell/NavStrip.tsx` — Settings item opens the modal (button, not NavLink).

**Shared types (defined once in `agentRegistry.ts`, mirrored in web `api.ts`):**
```ts
type AgentId = "claude" | "codex" | "gemini" | "opencode" | "openrouter";
type AgentAuthMethod = "subscription" | "apiKey";
type AgentConnection = "connected" | "notConnected" | "comingSoon";
```

Test commands:
- Server: `pnpm --filter @rigel/server test`
- Web: `pnpm --filter web test` · `pnpm --filter web typecheck`

---

## Task 1: Agent registry (descriptors + types)

**Files:**
- Create: `apps/server/src/agentRegistry.ts`
- Test: `apps/server/src/agentRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/agentRegistry.test.ts
import { test, expect } from "vitest";
import { listAgents, getAgent } from "./agentRegistry";

test("claude is the only available agent; the rest are coming soon", () => {
  const ids = listAgents().map((a) => a.id);
  expect(ids).toEqual(["claude", "codex", "gemini", "opencode", "openrouter"]);
  expect(getAgent("claude")?.status).toBe("available");
  for (const id of ["codex", "gemini", "opencode", "openrouter"] as const) {
    expect(getAgent(id)?.status).toBe("comingSoon");
  }
});

test("every agent offers at least one auth method; claude offers both", () => {
  for (const a of listAgents()) expect(a.authMethods.length).toBeGreaterThan(0);
  expect(getAgent("claude")?.authMethods).toEqual(["subscription", "apiKey"]);
  expect(getAgent("openrouter")?.authMethods).toEqual(["apiKey"]);
});

test("getAgent returns undefined for an unknown id", () => {
  expect(getAgent("bogus")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test agentRegistry`
Expected: FAIL — `Cannot find module './agentRegistry'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/server/src/agentRegistry.ts
// The catalogue of AI agents Rigel can drive. Pure data + lookups only — keep
// this free of heavy imports (claudeBridge/agentConfig) so nothing import-cycles
// through it. Only "claude" is wired to a real runner today (see runAgent.ts).

export type AgentId = "claude" | "codex" | "gemini" | "opencode" | "openrouter";
export type AgentAuthMethod = "subscription" | "apiKey";

export interface AgentDescriptor {
  id: AgentId;
  /** Product name, e.g. "Claude Code". */
  label: string;
  /** Vendor, e.g. "Anthropic". */
  vendor: string;
  /** "available" = has a real runner; "comingSoon" = listed but not runnable. */
  status: "available" | "comingSoon";
  /** Auth methods offered in the setup screen, in display order. */
  authMethods: AgentAuthMethod[];
  /** Step-1 "install / login" link. */
  installUrl: string;
  installLabel: string;
}

const AGENTS: AgentDescriptor[] = [
  {
    id: "claude",
    label: "Claude Code",
    vendor: "Anthropic",
    status: "available",
    authMethods: ["subscription", "apiKey"],
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
    installLabel: "Install Claude Code",
  },
  {
    id: "codex",
    label: "Codex",
    vendor: "OpenAI",
    status: "comingSoon",
    authMethods: ["subscription", "apiKey"],
    installUrl: "https://github.com/openai/codex",
    installLabel: "Install Codex",
  },
  {
    id: "gemini",
    label: "Gemini",
    vendor: "Google",
    status: "comingSoon",
    authMethods: ["subscription", "apiKey"],
    installUrl: "https://github.com/google-gemini/gemini-cli",
    installLabel: "Install Gemini CLI",
  },
  {
    id: "opencode",
    label: "OpenCode",
    vendor: "OpenCode",
    status: "comingSoon",
    authMethods: ["subscription", "apiKey"],
    installUrl: "https://opencode.ai",
    installLabel: "Install OpenCode",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    vendor: "OpenRouter",
    status: "comingSoon",
    authMethods: ["apiKey"],
    installUrl: "https://openrouter.ai/keys",
    installLabel: "Get an OpenRouter key",
  },
];

export function listAgents(): AgentDescriptor[] {
  return AGENTS;
}

export function getAgent(id: string): AgentDescriptor | undefined {
  return AGENTS.find((a) => a.id === id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/server test agentRegistry`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agentRegistry.ts apps/server/src/agentRegistry.test.ts
git commit -m "feat(server): agent registry (descriptors + lookups)"
```

---

## Task 2: Per-agent config + auth resolution

**Files:**
- Modify: `apps/server/src/chatConfig.ts` (make token-file path lazy)
- Create: `apps/server/src/agentConfig.ts`
- Test: `apps/server/src/agentConfig.test.ts`

- [ ] **Step 1: Make the Claude token-file path lazy (so tests can redirect `$HOME`)**

In `apps/server/src/chatConfig.ts`, replace the module-load constant:

```ts
const TOKEN_FILE = join(homedir(), ".claude", "rigel-oauth-token");
```

with a function:

```ts
function tokenFile(): string {
  return join(homedir(), ".claude", "rigel-oauth-token");
}
```

Then update the three references: in `fileToken()` use `await readFile(tokenFile(), "utf8")`; in `setClaudeToken()` use `await writeFile(tokenFile(), t, { mode: 0o600 })`; in `clearClaudeToken()` use `await unlink(tokenFile())`. No behavior change — only the path is now computed per call.

- [ ] **Step 2: Write the failing test**

```ts
// apps/server/src/agentConfig.test.ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test agentConfig`
Expected: FAIL — `Cannot find module './agentConfig'`.

- [ ] **Step 4: Write the implementation**

```ts
// apps/server/src/agentConfig.ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rigel/server test agentConfig`
Expected: PASS (4 tests). Also run `pnpm --filter @rigel/server test chatConfig` is not present; run the full suite once to confirm no regressions: `pnpm --filter @rigel/server test` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/chatConfig.ts apps/server/src/agentConfig.ts apps/server/src/agentConfig.test.ts
git commit -m "feat(server): per-agent auth config + claudeAuthEnv (lazy token path)"
```

---

## Task 3: Route Claude through `claudeAuthEnv` + add `runAgent` dispatcher

**Files:**
- Modify: `apps/server/src/claudeBridge.ts:270-282` (auth env injection) + its imports
- Create: `apps/server/src/runAgent.ts`
- Test: `apps/server/src/runAgent.test.ts`

- [ ] **Step 1: Switch Claude's env injection to `claudeAuthEnv()`**

In `apps/server/src/claudeBridge.ts`, change the import on line 4 from:

```ts
import { effectiveClaudeToken } from "./chatConfig";
```

to:

```ts
import { claudeAuthEnv } from "./agentConfig";
```

Then replace the token block (currently lines ~272–282):

```ts
  const token = await effectiveClaudeToken();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(context ? { KUBECONFIG_CONTEXT: context } : {}),
  };
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
```

with:

```ts
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(context ? { KUBECONFIG_CONTEXT: context } : {}),
    ...(await claudeAuthEnv()),
  };
```

- [ ] **Step 2: Write the failing test (the non-Claude fallback path)**

```ts
// apps/server/src/runAgent.test.ts
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./runAgent";
import type { ChatEvent } from "./claudeBridge";

let home: string;
const ORIG_HOME = process.env.HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rigel-runagent-"));
  process.env.HOME = home;
  await mkdir(join(home, ".claude"), { recursive: true });
});
afterEach(async () => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  await rm(home, { recursive: true, force: true });
});

test("a non-claude active agent yields a single 'not available' error event", async () => {
  // Force the active agent to a coming-soon one by writing the config directly.
  await writeFile(
    join(home, ".claude", "rigel-agents.json"),
    JSON.stringify({ activeAgentId: "codex", agents: {} }),
  );
  const events: ChatEvent[] = [];
  for await (const ev of runAgent("hi", null)) events.push(ev);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("error");
  expect(events[0].text).toMatch(/isn't available/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test runAgent`
Expected: FAIL — `Cannot find module './runAgent'`.

- [ ] **Step 4: Write the implementation**

```ts
// apps/server/src/runAgent.ts
// Dispatches a chat turn to the active agent's runner. Today only Claude has a
// real runner; any other active agent yields a single "not available" event.
import { runClaude, type ChatEvent, type RunClaudeOpts } from "./claudeBridge";
import { getAgent } from "./agentRegistry";
import { readAgentsConfig } from "./agentConfig";

export async function* runAgent(
  prompt: string,
  context: string | null,
  signal?: AbortSignal,
  opts?: RunClaudeOpts,
): AsyncGenerator<ChatEvent> {
  const { activeAgentId } = await readAgentsConfig();
  const agent = getAgent(activeAgentId);

  if (agent?.id === "claude") {
    yield* runClaude(prompt, context, signal, opts);
    return;
  }

  yield {
    type: "error",
    text: `The "${agent?.label ?? activeAgentId}" agent isn't available yet. Open Settings → Agents and connect Claude.`,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rigel/server test runAgent`
Expected: PASS (1 test). Then `pnpm --filter @rigel/server test` → all PASS (the `mapClaudeEvent` and other suites still green).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/claudeBridge.ts apps/server/src/runAgent.ts apps/server/src/runAgent.test.ts
git commit -m "feat(server): runAgent dispatcher; Claude auth via claudeAuthEnv"
```

---

## Task 4: `GET /api/agents` + `POST /api/agents/:id/auth`

**Files:**
- Modify: `apps/server/src/index.ts` (add routes near the existing `/api/chat-config` block, ~line 187)

- [ ] **Step 1: Add the imports**

At the top of `apps/server/src/index.ts`, near the existing `chatConfig`/`setClaudeToken` import, add:

```ts
import { agentsView, setAgentAuth, type AgentAuthMethod } from "./agentConfig";
import { getAgent } from "./agentRegistry";
```

- [ ] **Step 2: Add the routes**

Immediately after the existing `POST /api/chat-config` block (the one that ends `return Response.json(await chatConfig());`), insert:

```ts
    if (url.pathname === "/api/agents" && req.method === "GET") {
      return Response.json(await agentsView());
    }

    // POST /api/agents/<id>/auth  { authMethod, secret? }
    if (
      url.pathname.startsWith("/api/agents/") &&
      url.pathname.endsWith("/auth") &&
      req.method === "POST"
    ) {
      const id = url.pathname.split("/")[3] ?? "";
      const agent = getAgent(id);
      if (!agent) return Response.json({ error: "unknown agent" }, { status: 404 });
      if (agent.status === "comingSoon") {
        return Response.json({ error: "agent not available yet" }, { status: 409 });
      }
      const body = (await req.json().catch(() => ({}))) as {
        authMethod?: unknown;
        secret?: unknown;
      };
      const authMethod = body.authMethod === "apiKey" ? "apiKey" : "subscription";
      if (!agent.authMethods.includes(authMethod as AgentAuthMethod)) {
        return Response.json({ error: "unsupported auth method" }, { status: 400 });
      }
      const secret = typeof body.secret === "string" ? body.secret : "";
      if (authMethod === "apiKey" && !secret.trim()) {
        return Response.json({ error: "an API key is required" }, { status: 400 });
      }
      const view = await setAgentAuth(agent.id, { authMethod, secret });
      return Response.json(view);
    }
```

- [ ] **Step 3: Verify (typecheck + build — no live mutation calls)**

Run: `pnpm --filter @rigel/server build`
Expected: builds with no type errors. (Per project rule, do **not** curl mutation endpoints against a live cluster; the logic is covered by Task 2's `setAgentAuth`/`agentsView` unit tests.)

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): /api/agents (list) + /api/agents/:id/auth (save)"
```

---

## Task 5: Chat uses the active agent

**Files:**
- Modify: `apps/server/src/ws.ts:79` + its `runClaude` import

- [ ] **Step 1: Swap the call site**

In `apps/server/src/ws.ts`, change the import of `runClaude` to `runAgent`:

```ts
import { runAgent } from "./runAgent";
```

(remove the now-unused `runClaude` import). Then on line ~79 change:

```ts
            for await (const event of runClaude(m.prompt, context, ac.signal, { model, effort, sessionId })) {
```

to:

```ts
            for await (const event of runAgent(m.prompt, context, ac.signal, { model, effort, sessionId })) {
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter @rigel/server build && pnpm --filter @rigel/server test`
Expected: builds clean; all server tests PASS. (Claude remains the active agent by default, so chat behavior is unchanged.)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/ws.ts
git commit -m "feat(server): route chat through runAgent (active agent)"
```

---

## Task 6: Web hooks for agents

**Files:**
- Modify: `apps/web/src/lib/api.ts` (add types + hooks near the `useChatConfig` block, ~line 687)
- Test: `apps/web/src/lib/agents.test.ts`

- [ ] **Step 1: Add types + hooks**

In `apps/web/src/lib/api.ts`, after the `useSetChatToken()` definition, add:

```ts
// ── Agents (multi-backend settings) ──────────────────────────────────────────
export type AgentId = "claude" | "codex" | "gemini" | "opencode" | "openrouter";
export type AgentAuthMethod = "subscription" | "apiKey";
export type AgentConnection = "connected" | "notConnected" | "comingSoon";

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

async function fetchAgents(): Promise<AgentsResponse> {
  const res = await fetch("/api/agents");
  if (!res.ok) throw new Error("failed to load agents");
  return (await res.json()) as AgentsResponse;
}

export function useAgents() {
  return useQuery({
    queryKey: ["agents"] as const,
    queryFn: fetchAgents,
    staleTime: 30_000,
  });
}

export interface SetAgentAuthVars {
  id: AgentId;
  authMethod: AgentAuthMethod;
  secret?: string;
}

export function useSetAgentAuth() {
  const qc = useQueryClient();
  return useMutation<AgentView, Error, SetAgentAuthVars>({
    mutationFn: async ({ id, authMethod, secret }) => {
      const res = await fetch(`/api/agents/${id}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authMethod, secret }),
      });
      if (!res.ok) throw new Error((await res.text()) || "failed to save");
      return (await res.json()) as AgentView;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}
```

(Leave `useChatConfig`/`useSetChatToken`/`ChatConfig` in place — onboarding may still use them.)

- [ ] **Step 2: Write the failing test (pill-label helper)**

To keep a small piece of testable pure logic, add a label helper to `api.ts` and test it:

```ts
// apps/web/src/lib/agents.test.ts
import { describe, it, expect } from "vitest";
import { connectionLabel } from "./api";

describe("connectionLabel", () => {
  it("maps connection states to display labels", () => {
    expect(connectionLabel("connected")).toBe("Connected");
    expect(connectionLabel("notConnected")).toBe("Not connected");
    expect(connectionLabel("comingSoon")).toBe("Coming soon");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter web test agents`
Expected: FAIL — `connectionLabel` is not exported.

- [ ] **Step 4: Add the helper**

In `apps/web/src/lib/api.ts`, below the hooks added in Step 1:

```ts
export function connectionLabel(c: AgentConnection): string {
  return c === "connected" ? "Connected" : c === "notConnected" ? "Not connected" : "Coming soon";
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter web test agents && pnpm --filter web typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/agents.test.ts
git commit -m "feat(web): useAgents/useSetAgentAuth hooks + connectionLabel"
```

---

## Task 7: Export the reusable settings sections

**Files:**
- Modify: `apps/web/src/panels/settings/SettingsPanel.tsx`

- [ ] **Step 1: Export the two sections; remove the Claude-token section + default panel**

In `apps/web/src/panels/settings/SettingsPanel.tsx`:
1. Change `function SignalSection(` → `export function SignalSection(`.
2. Change `function SelfHostSection(` → `export function SelfHostSection(`.
3. Delete the entire `CopilotSection` function (lines ~73–162) and its now-unused imports (`useChatConfig`, `useSetChatToken`, `useNavigate`, `Key`, `ArrowRight` — **only** remove those not referenced by the remaining two sections; verify with the grep in Step 2).
4. Delete the default `export default function SettingsPanel()` (lines ~55–67) — its route is being removed in Task 10.

- [ ] **Step 2: Verify nothing else imports the removed symbols**

Run:
```bash
grep -rn "SettingsPanel" apps/web/src
grep -rn "CopilotSection" apps/web/src
```
Expected: the only remaining `SettingsPanel` reference is the import + `<Route>` in `App.tsx` (removed in Task 10); no `CopilotSection` references remain. If the grep shows a leftover import elsewhere, note it for Task 10.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: it will FAIL only on `App.tsx` still importing the now-removed default `SettingsPanel` — that is expected and fixed in Task 10. If it fails anywhere else, fix that import before continuing.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/panels/settings/SettingsPanel.tsx
git commit -m "refactor(web): export Signal/SelfHost sections; drop Copilot section"
```

---

## Task 8: Agents tab (glyphs, card, setup, grid)

**Files:**
- Create: `apps/web/src/panels/settings/agents/agentGlyphs.tsx`
- Create: `apps/web/src/panels/settings/agents/AgentCard.tsx`
- Create: `apps/web/src/panels/settings/agents/AgentSetup.tsx`
- Create: `apps/web/src/panels/settings/agents/AgentsTab.tsx`
- Test: `apps/web/src/panels/settings/agents/AgentCard.test.tsx`
- Test: `apps/web/src/panels/settings/agents/AgentSetup.test.tsx`

- [ ] **Step 1: Vendor glyphs**

```tsx
// apps/web/src/panels/settings/agents/agentGlyphs.tsx
// Small monochrome vendor glyphs (currentColor). Intentionally simple — brand-
// accurate marks can replace these later. Falls back to a generic bot.
import { Bot } from "lucide-react";
import type { AgentId } from "@/lib/api";

export function AgentGlyph({ id, size = 22 }: { id: AgentId; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none" as const };
  switch (id) {
    case "claude": // Anthropic-ish burst
      return (
        <svg {...common} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
          {Array.from({ length: 8 }).map((_, i) => {
            const a = (i * Math.PI) / 4;
            return <line key={i} x1={12} y1={12} x2={12 + 8 * Math.cos(a)} y2={12 + 8 * Math.sin(a)} />;
          })}
        </svg>
      );
    case "codex": // OpenAI-ish ring
      return (
        <svg {...common} stroke="currentColor" strokeWidth={1.8}>
          <circle cx={12} cy={12} r={7} />
          <circle cx={12} cy={12} r={2.5} fill="currentColor" stroke="none" />
        </svg>
      );
    case "gemini": // four-point spark
      return (
        <svg {...common} fill="currentColor">
          <path d="M12 2c.6 4.4 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8z" />
        </svg>
      );
    default:
      return <Bot size={size} />;
  }
}
```

- [ ] **Step 2: Write the failing AgentCard test**

```tsx
// apps/web/src/panels/settings/agents/AgentCard.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentCard } from "./AgentCard";
import type { AgentView } from "@/lib/api";

const base: AgentView = {
  id: "claude", label: "Claude Code", vendor: "Anthropic", status: "available",
  connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install",
};

describe("AgentCard", () => {
  it("shows the connection label and fires onOpen", () => {
    const onOpen = vi.fn();
    render(<AgentCard agent={base} onOpen={onOpen} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith("claude");
  });

  it("labels a coming-soon agent", () => {
    render(<AgentCard agent={{ ...base, id: "codex", status: "comingSoon", connection: "comingSoon" }} onOpen={() => {}} />);
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter web test AgentCard`
Expected: FAIL — `Cannot find module './AgentCard'`.

- [ ] **Step 4: Implement AgentCard**

```tsx
// apps/web/src/panels/settings/agents/AgentCard.tsx
import { ArrowRight } from "lucide-react";
import { connectionLabel, type AgentId, type AgentView } from "@/lib/api";
import { AgentGlyph } from "./agentGlyphs";

const DOT: Record<AgentView["connection"], string> = {
  connected: "var(--status-running)",
  notConnected: "var(--status-pending)",
  comingSoon: "var(--fg-tertiary)",
};

export function AgentCard({ agent, onOpen }: { agent: AgentView; onOpen: (id: AgentId) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(agent.id)}
      className="flex flex-col gap-4 rounded-xl border p-4 text-left transition-colors hover:bg-[#1B1C1F]"
      style={{ background: "var(--surface-elevated)", borderColor: "var(--border-subtle)" }}
    >
      <div className="flex items-start justify-between">
        <div>
          <div style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>{agent.vendor}</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-primary)" }}>{agent.label}</div>
        </div>
        <span style={{ color: "var(--fg-secondary)" }}><AgentGlyph id={agent.id} /></span>
      </div>

      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5" style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: DOT[agent.connection] }} />
          {connectionLabel(agent.connection)}
        </span>
        <ArrowRight size={14} style={{ color: "var(--fg-tertiary)" }} />
      </div>
    </button>
  );
}
```

- [ ] **Step 5: Run AgentCard test → PASS**

Run: `pnpm --filter web test AgentCard`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the failing AgentSetup test**

```tsx
// apps/web/src/panels/settings/agents/AgentSetup.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentSetup } from "./AgentSetup";
import type { AgentView } from "@/lib/api";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const claude: AgentView = {
  id: "claude", label: "Claude Code", vendor: "Anthropic", status: "available",
  connection: "notConnected", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install Claude Code",
};

describe("AgentSetup", () => {
  it("enables Save for an available agent", () => {
    wrap(<AgentSetup agent={claude} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: /save/i })).not.toBeDisabled();
  });

  it("disables Save and shows a notice for a coming-soon agent", () => {
    wrap(<AgentSetup agent={{ ...claude, id: "codex", status: "comingSoon", connection: "comingSoon" }} onBack={() => {}} />);
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter web test AgentSetup`
Expected: FAIL — `Cannot find module './AgentSetup'`.

- [ ] **Step 8: Implement AgentSetup**

```tsx
// apps/web/src/panels/settings/agents/AgentSetup.tsx
import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useSetAgentAuth, type AgentAuthMethod, type AgentView } from "@/lib/api";
import { AgentGlyph } from "./agentGlyphs";

const METHOD_LABEL: Record<AgentAuthMethod, string> = {
  subscription: "Your existing CLI login (subscription)",
  apiKey: "API key",
};

export function AgentSetup({ agent, onBack }: { agent: AgentView; onBack: () => void }) {
  const comingSoon = agent.status === "comingSoon";
  const save = useSetAgentAuth();
  const [method, setMethod] = useState<AgentAuthMethod>(agent.authMethod);
  const [secret, setSecret] = useState("");

  const needsSecret = method === "apiKey";
  const saveDisabled = comingSoon || save.isPending || (needsSecret && !secret.trim());

  async function onSave() {
    await save.mutateAsync({ id: agent.id, authMethod: method, secret: secret.trim() });
    setSecret("");
  }

  return (
    <div className="flex flex-col gap-5">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 self-start" style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
        <ChevronLeft size={15} /> Back
      </button>

      <div className="flex items-center gap-2.5" style={{ color: "var(--fg-primary)" }}>
        <AgentGlyph id={agent.id} size={24} />
        <div style={{ fontSize: 18, fontWeight: 600 }}>{agent.label}</div>
        {comingSoon && (
          <span className="rounded-full px-2 py-0.5" style={{ fontSize: 11, color: "var(--fg-tertiary)", border: "1px solid var(--border-subtle)" }}>
            Coming soon
          </span>
        )}
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-primary)" }}>Step 1</div>
        <a href={agent.installUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: "var(--accent-primary)" }}>
          {agent.installLabel}
        </a>
      </div>

      <div className="flex flex-col gap-2">
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-primary)" }}>Step 2 — Authenticate with</div>
        {agent.authMethods.map((m) => (
          <label key={m} className="flex items-center gap-2" style={{ fontSize: 13, color: "var(--fg-secondary)", opacity: comingSoon ? 0.6 : 1 }}>
            <input type="radio" name="auth" disabled={comingSoon} checked={method === m} onChange={() => setMethod(m)} />
            {METHOD_LABEL[m]}
          </label>
        ))}

        {needsSecret && (
          <input
            type="password"
            value={secret}
            disabled={comingSoon}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={agent.id === "claude" ? "sk-ant-…" : "API key"}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        )}
      </div>

      {comingSoon && (
        <p style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>
          This agent isn't connectable yet. We're building its runner — for now, use Claude.
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saveDisabled}
          onClick={onSave}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {save.isError && <span style={{ fontSize: 12, color: "var(--destructive)" }}>{save.error.message}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Run AgentSetup test → PASS**

Run: `pnpm --filter web test AgentSetup`
Expected: PASS (2 tests).

- [ ] **Step 10: Implement AgentsTab (grid ↔ setup)**

```tsx
// apps/web/src/panels/settings/agents/AgentsTab.tsx
import { useState } from "react";
import { useAgents, type AgentId } from "@/lib/api";
import { AgentCard } from "./AgentCard";
import { AgentSetup } from "./AgentSetup";

export function AgentsTab() {
  const { data, isLoading } = useAgents();
  const [selected, setSelected] = useState<AgentId | null>(null);

  if (isLoading || !data) {
    return <p style={{ fontSize: 13, color: "var(--fg-tertiary)" }}>Loading agents…</p>;
  }

  const current = selected ? data.agents.find((a) => a.id === selected) : null;
  if (current) return <AgentSetup agent={current} onBack={() => setSelected(null)} />;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-primary)" }}>Connect your AI agent</h2>
        <p style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
          Use an existing subscription or an API key. Your credentials never leave your machine.
        </p>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {data.agents.map((a) => (
          <AgentCard key={a.id} agent={a} onOpen={setSelected} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 11: Typecheck + run the agents tests**

Run: `pnpm --filter web typecheck && pnpm --filter web test agents/`
Expected: typecheck clean (App.tsx error from Task 7 still pending — ignore until Task 10 if running full typecheck; scope this run to the new files passing). AgentCard + AgentSetup tests PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/panels/settings/agents/
git commit -m "feat(web): Agents tab (grid, card, per-agent setup, glyphs)"
```

---

## Task 9: Settings modal shell + tabs

**Files:**
- Create: `apps/web/src/panels/settings/SettingsModal.tsx`

- [ ] **Step 1: Implement the modal**

```tsx
// apps/web/src/panels/settings/SettingsModal.tsx
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SignalSection, SelfHostSection } from "./SettingsPanel";
import { AgentsTab } from "./agents/AgentsTab";
import { useSettings } from "./useSettings";

type TabId = "general" | "agents" | "integrations" | "about";
const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "integrations", label: "Integrations" },
  { id: "about", label: "About" },
];

export function SettingsModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [tab, setTab] = useState<TabId>("agents");
  // Integrations tab needs the same wiring SettingsPanel used for SignalSection.
  const [applying, setApplying] = useState(false);
  const derived = useSettings(applying);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="w-[calc(100%-2rem)] !max-w-3xl"
        style={{ background: "var(--surface-primary)" }}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>

        {/* Tab bar */}
        <div className="flex gap-1 border-b pb-2" style={{ borderColor: "var(--border-subtle)" }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="rounded-md px-3 py-1.5"
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: tab === t.id ? "var(--fg-primary)" : "var(--fg-tertiary)",
                background: tab === t.id ? "var(--surface-elevated)" : "transparent",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="pt-1">
          {tab === "general" && <SelfHostSection />}
          {tab === "agents" && <AgentsTab />}
          {tab === "integrations" && (
            <SignalSection derived={derived} applying={applying} setApplying={setApplying} />
          )}
          {tab === "about" && (
            <p style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
              Rigel — a self-hostable, AI-native Kubernetes admin UI.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: clean except the pending `App.tsx` `SettingsPanel` default-import error (fixed next task). Confirm `useSettings` is imported from the right path — adjust `./useSettings` if the file lives elsewhere (it is `apps/web/src/panels/settings/useSettings.ts`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/settings/SettingsModal.tsx
git commit -m "feat(web): tabbed SettingsModal (General/Agents/Integrations/About)"
```

---

## Task 10: Wire the triggers (header gear + nav item), remove the route

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/shell/GlobalHeader.tsx`
- Modify: `apps/web/src/shell/NavStrip.tsx`

- [ ] **Step 1: App.tsx — modal state, render, remove route + import**

In `apps/web/src/App.tsx`:
1. Remove `import SettingsPanel from "@/panels/settings/SettingsPanel";` (or whatever the exact import line is) and add `import { SettingsModal } from "@/panels/settings/SettingsModal";`.
2. Add modal state near the `paletteOpen` state (line ~75): `const [settingsOpen, setSettingsOpen] = useState(false);`
3. Remove the settings route line (line ~258): `<Route path="/settings" element={<Padded><SettingsPanel /></Padded>} />`.
4. Pass `onOpenSettings` to `GlobalHeader` (line ~203):

```tsx
        <GlobalHeader
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onOpenSearch={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
```

5. Pass `onOpenSettings` to `NavStrip` wherever it is rendered (search `<NavStrip`): add `onOpenSettings={() => setSettingsOpen(true)}`.
6. Render the modal next to `<CommandPalette ... />` (line ~197):

```tsx
        <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
```

- [ ] **Step 2: GlobalHeader — add the gear button**

In `apps/web/src/shell/GlobalHeader.tsx`:
1. Add `Settings` to the lucide import: `import { PanelLeftClose, PanelLeftOpen, Search, Settings } from "lucide-react";`
2. Extend the props interface:

```ts
interface GlobalHeaderProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
}
```

3. Add `onOpenSettings` to the destructured params.
4. Insert a gear button between the Search button and the connection-status indicator (right side):

```tsx
      {/* Settings */}
      <button
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: 6,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          flexShrink: 0,
        }}
        className="hover:bg-[#1B1C1F] transition-colors"
      >
        <Settings size={16} style={{ color: "var(--fg-secondary)" }} />
      </button>
```

- [ ] **Step 3: NavStrip — Settings item opens the modal**

In `apps/web/src/shell/NavStrip.tsx`:
1. Change the props:

```ts
export default function NavStrip({
  collapsed = false,
  onOpenSettings,
}: {
  collapsed?: boolean;
  onOpenSettings: () => void;
}) {
```

2. Give `NavButton` an optional action override so the "settings" entry renders a `<button>` instead of a route `<NavLink>`. Update `NavButtonProps` and the top of `NavButton`:

```tsx
type NavButtonProps = { panelKey: string; collapsed?: boolean; onClick?: () => void };

function NavButton({ panelKey, collapsed = false, onClick }: NavButtonProps) {
  const meta = PANEL_META[panelKey];
  if (!meta) return null;
  const Icon = meta.icon;

  // Action item (e.g. Settings opens a modal, not a route).
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={meta.title}
        className={
          collapsed
            ? "flex items-center justify-center h-8 w-full rounded-md transition-colors group nav-btn-idle hover:bg-[#1B1C1F]"
            : "flex items-center gap-2.5 px-2.5 h-8 w-full rounded-md transition-colors group nav-btn-idle hover:bg-[#1B1C1F]"
        }
      >
        <Icon size={14} strokeWidth={1.75} style={{ color: "var(--fg-tertiary)", flexShrink: 0, width: 20 }} className="group-hover:!text-[#A1A1AA]" />
        {!collapsed && (
          <span style={{ fontSize: "13px", color: "var(--fg-secondary)", fontWeight: 500 }} className="group-hover:!text-white">
            {meta.title}
          </span>
        )}
      </button>
    );
  }

  return (
    // ...existing NavLink render unchanged...
```

3. Where the System-group panels are rendered, pass the override for `settings`. Find where `NavButton` is mapped for a group's `panels` and special-case:

```tsx
{group.panels.map((panelKey) =>
  panelKey === "settings" ? (
    <NavButton key={panelKey} panelKey={panelKey} collapsed={collapsed} onClick={onOpenSettings} />
  ) : (
    <NavButton key={panelKey} panelKey={panelKey} collapsed={collapsed} />
  ),
)}
```

(If the existing map already destructures differently, keep its structure and only add the `onClick` for the `settings` key.)

- [ ] **Step 4: Full typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: BOTH clean (the earlier pending `App.tsx`/`SettingsPanel` error is now resolved).

- [ ] **Step 5: Run the full web test suite**

Run: `pnpm --filter web test`
Expected: all PASS (including the new agents tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/shell/GlobalHeader.tsx apps/web/src/shell/NavStrip.tsx
git commit -m "feat(web): open SettingsModal from header gear + nav; drop /settings route"
```

---

## Task 11: Full verification

- [ ] **Step 1: Server — build + test**

Run: `pnpm --filter @rigel/server build && pnpm --filter @rigel/server test`
Expected: build clean; all server tests PASS.

- [ ] **Step 2: Web — typecheck + build + test**

Run: `pnpm --filter web typecheck && pnpm --filter web build && pnpm --filter web test`
Expected: all clean / PASS.

- [ ] **Step 3: Desktop bundle (the server change is bundled here)**

Run: `cd apps/desktop && node build.mjs`
Expected: `dist/server.mjs`, `dist/main.js`, etc. all build with no errors.

- [ ] **Step 4: Manual smoke (optional, recommended)**

Run: `pnpm --filter desktop dev`
Verify: the header gear and the NavStrip "Settings" item both open the modal; the Agents tab lists Claude (Connected/Not connected) + four "Coming soon" agents; opening Claude → Setup shows the subscription/API-key radios; opening a coming-soon agent shows the disabled form + notice. Chat still streams from Claude.

- [ ] **Step 5: Final commit (if any stray fixes from smoke)**

```bash
git add -A
git commit -m "chore: multi-agent settings modal — verification fixes"
```

---

## Spec coverage check

- Tabbed modal (General/Agents/Integrations/About) → Task 9.
- Agents grid + per-agent setup, subscription OR API key → Task 8.
- Claude live; others "Coming soon" (disabled connect) → Tasks 1, 8.
- Server agent registry + `runAgent` wrapping `runClaude` → Tasks 1, 3.
- Per-agent config storage (0600) + `claudeAuthEnv` → Task 2.
- `/api/agents` (list) + `/api/agents/:id/auth` (save) → Task 4.
- Chat routes through the active agent → Task 5.
- Header gear (primary trigger) + NavStrip item; `/settings` route removed → Task 10.
- Migrate existing Settings sections into tabs → Tasks 7, 9.
- Deferred (per spec): active-agent switcher, real non-Claude runners, per-agent model picker, MCP tab — NOT in this plan (tracked in Plane HELM-1…8).
