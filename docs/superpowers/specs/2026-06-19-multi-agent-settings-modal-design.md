# Multi-agent settings modal — design

Date: 2026-06-19
Branch: feature/ui-slim-and-fixes (or a new feature branch)
Status: approved design, pre-implementation

## Goal

Let users set up AI agents other than Claude. Replace the routed `/settings`
panel with a Pencil-style **tabbed settings modal** whose centerpiece is an
**Agents** tab: a card grid of providers, each with a per-agent setup flow that
authenticates via **either an existing CLI subscription or an API key**.

First cut keeps **Claude fully live**; other agents render in the grid and have a
real setup screen but are marked **"Coming soon"** (their connect action is
disabled) until per-provider backends land. This slice ships the modal UX, a
server-side **agent abstraction**, and **per-agent config storage** so future
runners drop in without UI or storage rework.

The Rigel app-logo swap (Electron icon + GlobalHeader mark) was completed
separately and is out of scope for this spec.

## Decisions (from brainstorming)

- **Scope:** modal + abstraction, Claude live; other agents "Coming soon".
- **Auth model:** both per agent — subscription-CLI OR API key (radio choice).
- **Modal shape:** full tabbed settings modal; migrate existing Settings panel
  sections into tabs.
- **Provider list (initial):** Claude (live), OpenAI Codex, Google Gemini,
  OpenCode, OpenRouter. Deepseek/Moonshot/Together are trivial to add later.
- **`/settings` route collapses into the modal** (Settings nav item opens it).

## Current state (what we build on)

- AI is hard-wired to the `claude` CLI: `apps/server/src/claudeBridge.ts`
  (`runClaude()`, `buildClaudeArgs()`); token in `apps/server/src/chatConfig.ts`
  (`effectiveClaudeToken()`, `setClaudeToken()`, `clearClaudeToken()`,
  `chatConfig()`), precedence `CLAUDE_CODE_OAUTH_TOKEN` env > file
  `~/.claude/helmsman-oauth-token` (0600), optional k8s Secret via
  `HELMSMAN_CLAUDE_SECRET` + `POD_NAMESPACE`.
- WS chat handler `apps/server/src/ws.ts` calls `runClaude(...)`.
- Endpoints `GET/POST /api/chat-config` in `apps/server/src/index.ts`.
- Settings UI `apps/web/src/panels/settings/SettingsPanel.tsx` with
  `CopilotSection` (Claude token), `SignalSection` (Signal/SMS bridge),
  `SelfHostSection` (per-context localStorage defaults); state in
  `useSettings.ts`. Web hooks `useChatConfig()`, `useSetChatToken()` in
  `apps/web/src/lib/api.ts`.
- shadcn `Dialog` already present: `apps/web/src/components/ui/dialog.tsx`.
- No provider/agent abstraction exists today.

## Architecture

### Server: agent registry + per-agent config

**`apps/server/src/agentRegistry.ts`** (new) — the single source of truth for
which agents exist and how to run them.

```ts
type AgentId = "claude" | "codex" | "gemini" | "opencode" | "openrouter";
type AgentAuthMethod = "subscription" | "apiKey";

interface AgentDescriptor {
  id: AgentId;
  label: string;        // "Claude Code"
  vendor: string;       // "Anthropic"
  status: "available" | "comingSoon";
  authMethods: AgentAuthMethod[];
  installUrl?: string;  // Step 1 link target
  installLabel?: string;// "Install Claude Code"
  run?: RunFn;          // only "claude" implements it (wraps runClaude)
}

const AGENTS: AgentDescriptor[] = [ /* claude available; others comingSoon */ ];
export function listAgents(): AgentDescriptor[];
export function getAgent(id: AgentId): AgentDescriptor | undefined;
```

Claude's `run` wraps the existing `runClaude` from `claudeBridge.ts` — no
behavior change for the live path.

**`apps/server/src/agentConfig.ts`** (new; generalizes `chatConfig.ts`) — owns
persisted per-agent auth and the active agent.

- File: `~/.claude/helmsman-agents.json`, mode `0600`:
  ```json
  {
    "activeAgentId": "claude",
    "agents": {
      "claude": { "authMethod": "subscription" },
      "codex":  { "authMethod": "apiKey", "apiKey": "sk-..." }
    }
  }
  ```
- **Claude subscription stays on the existing path:** the OAuth token continues
  to resolve via `CLAUDE_CODE_OAUTH_TOKEN` env > `~/.claude/helmsman-oauth-token`
  (0600). `effectiveClaudeToken()` is kept and reused by `claudeBridge.ts`.
- **API keys** live in `helmsman-agents.json` (0600). When an agent's active
  method is `apiKey`, its key is injected as the right env var at spawn
  (Claude → `ANTHROPIC_API_KEY`).
- API surface (limited, reused — not parallel near-duplicates):
  `readAgentConfig()`, `setAgentAuth(id, { authMethod, apiKey? })`,
  `setActiveAgent(id)`, `agentStatus(id)`.
- **`chatConfig.ts` is refactored**, not duplicated: its Claude token helpers
  become the Claude provider's auth inside `agentConfig`/`claudeBridge`; the
  `chatConfig()` aggregate is removed once the UI stops calling `/api/chat-config`.

**Status computation** (`agentStatus`):
- `comingSoon` agents → always `"comingSoon"`.
- `available` agent → `"connected"` if the credential for its selected
  `authMethod` is present (subscription: `effectiveClaudeToken()` non-empty;
  apiKey: stored key non-empty), else `"notConnected"`.

**Endpoints** (`apps/server/src/index.ts`) — replace `/api/chat-config`:
- `GET /api/agents` → `{ activeAgentId, agents: AgentView[] }` where
  `AgentView = { id, label, vendor, status, authMethods, authMethod,
  installUrl, installLabel, envManaged }`. Never returns secret values; only
  whether a credential is set (`status`).
- `POST /api/agents/:id/auth` → body `{ authMethod, apiKey? }`. Saves config;
  for Claude `apiKey` stores the key, `subscription` clears any stored key.
  Returns the updated `AgentView`.

(No active-agent switch endpoint this slice — see Deferred. `activeAgentId`
stays `claude` and is read by `runAgent`.)

**WS chat** (`ws.ts`): replace the direct `runClaude(...)` call with
`runAgent(activeAgentId, ...)` — looks up the registry and invokes that agent's
`run`. Defaults to Claude; if the active agent has no runner, emit a single
error `ChatEvent` ("This agent isn't available yet"). Today only Claude is
active/available, so the live behavior is unchanged.

### Web: tabbed settings modal

**Trigger / routing.** The NavStrip **Settings** entry becomes a button that
opens the modal (state lifted to `App.tsx`, same pattern as the ⌘K
CommandPalette `paletteOpen`). The `/settings` route is removed. `App.tsx`
renders `<SettingsModal open onOpenChange .../>`.

**`apps/web/src/panels/settings/SettingsModal.tsx`** (new) — shadcn `Dialog`
with a top tab bar (pill-style, echoing the reference), dark-themed via existing
CSS tokens. Tabs:
- **General** → renders the existing `SelfHostSection`.
- **Agents** → new `AgentsTab` (centerpiece).
- **Integrations** → renders the existing `SignalSection`.
- **About** → app version + onboarding identity (name/email), small/static.

`SelfHostSection` and `SignalSection` are kept as exported components and reused
by their tabs (moved, not rewritten). The old `CopilotSection` Claude-token UI is
superseded by the Agents tab's Claude setup view and is removed.

**Agents tab — two views** (`apps/web/src/panels/settings/agents/`):

- `AgentsTab.tsx` — owns a local `selectedAgentId | null`. Null → grid; set →
  setup view. Header copy: "Connect your AI agent — use an existing subscription
  or an API key. Your credentials never leave your machine."
- `AgentCard.tsx` — provider name + vendor, a glyph, a status pill
  (`Connected` green `--status-running` / `Not connected` amber
  `--status-pending` / `Coming soon` muted), and a **Setup** / **Manage** button.
- `AgentSetup.tsx` — "Setup your &lt;Agent&gt;" + Back. **Step 1** install/login
  link (`installUrl`/`installLabel`). **Step 2** "Authenticate with:" radio:
  (a) Existing CLI / subscription, (b) API key → reveals a masked key field +
  Save. For **Claude**: subscription shows current connection status (reuses the
  token plumbing); apiKey saves `ANTHROPIC_API_KEY`. For **comingSoon** agents:
  the form renders read-only/disabled with a "Coming soon" note; Connect/Save is
  disabled.
- `agentGlyphs.tsx` — small monochrome inline-SVG glyphs per vendor (Anthropic,
  OpenAI, Google, OpenCode, OpenRouter), matching the muted aesthetic.
- `useAgents.ts` — TanStack Query hooks: `useAgents()` (GET), `useSetAgentAuth()`
  (POST auth). These **replace** `useChatConfig()`/`useSetChatToken()`; the old
  hooks are removed.

**Styling.** Cards on `--surface-elevated`/`--surface-sunken` with
`--border-subtle`; status pills use the status tokens. Grid is responsive
(`repeat(auto-fill, minmax(~240px, 1fr))`), echoing the 3-up reference.

## Data flow

1. Modal opens → `useAgents()` GETs `/api/agents` → grid renders cards with live
   status.
2. User opens an agent → `AgentSetup` → picks method, saves → `useSetAgentAuth()`
   POSTs → query invalidated → status pill updates.
3. (Future) selecting a different available agent → `useSetActiveAgent()` →
   WS chat routes to that runner. Today only Claude is available.
4. Chat unchanged: WS `chat` → `runAgent(activeAgentId=claude, ...)` → existing
   `runClaude` stream.

## Error handling

- Save with `apiKey` method but empty key → 400, inline field error.
- `comingSoon` agents reject auth saves (their setup form is disabled anyway).
- Secrets never sent to the client; `GET /api/agents` exposes only `status`.
- Config file written atomically with mode `0600`; read failures fall back to an
  empty config (active = `claude`) rather than crashing.

## Testing

- **Server (vitest):** `agentConfig` read/write/precedence + `0600` perms;
  `agentStatus` for connected/notConnected/comingSoon; endpoint handlers
  (`GET /api/agents`, `POST .../auth`). Reuse existing server test patterns.
- **Web (vitest):** `useAgents` response→view mapping; `AgentCard` pill states;
  `AgentSetup` disables Connect for comingSoon and toggles the API-key field by
  method.

## Deferred (explicitly out of scope)

- Real Codex / Gemini / OpenCode / OpenRouter runners (the action-block + system
  prompt are Claude-specific and will need generalizing per provider).
- Active-agent **switcher** (the `POST /api/agents/active` endpoint +
  `useSetActiveAgent` hook + any UI). `activeAgentId` stays `claude` until a
  second runner exists.
- Making the composer model/effort picker (`composerModel.ts` / `PaneComposer`)
  per-agent.
- An MCP tab.
- Multi-cluster, account/billing tabs.

## File map

New:
- `apps/server/src/agentRegistry.ts`
- `apps/server/src/agentConfig.ts`
- `apps/web/src/panels/settings/SettingsModal.tsx`
- `apps/web/src/panels/settings/agents/{AgentsTab,AgentCard,AgentSetup,agentGlyphs,useAgents}.tsx`

Changed:
- `apps/server/src/index.ts` (swap `/api/chat-config` → `/api/agents*`)
- `apps/server/src/ws.ts` (`runClaude` → `runAgent(activeAgentId,...)`)
- `apps/server/src/chatConfig.ts` (refactor into agentConfig; keep
  `effectiveClaudeToken`)
- `apps/web/src/App.tsx` (modal open state + render)
- `apps/web/src/shell/NavStrip.tsx` (Settings entry opens modal)
- `apps/web/src/panels/settings/SettingsPanel.tsx` (sections moved into tabs;
  `CopilotSection` removed)
- `apps/web/src/lib/api.ts` (remove `useChatConfig`/`useSetChatToken`)

## Docs/tickets follow-up (per workflow)

Update the app's Outline doc with the new Agents/settings-modal surface and the
multi-backend direction, then derive Plane tickets for the deferred per-provider
runners.
