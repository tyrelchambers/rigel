# Cluster Assistant Multi-Provider — Plan 3: Assistant UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the web UI for the user-selectable AI providers feature on top of Plans 1 (agent core) and 2 (control plane), both already landed. Add an **Agents** tab to the Assistant panel that lets the user pick a provider + model + reasoning-effort for the **Worker** and **Supervisor** roles, manage per-provider credentials, and edit operational limits — reading the CURRENT values from the live `assistant-config` ConfigMap (via the same `useAssistant`/cluster-store mechanism `RulesTab` uses) and saving via the LIVE patch actions `setModels` (role changes), `setLimits` (limits), and `setCredentials` (keys, with a confirm step since it rollout-restarts the agent). Extend `InstallView` so a fresh install collects the two role selections + the credentials for the chosen providers (calling `install` with `worker`/`supervisor`/`credentials`/`limits`), defaults unchanged (Claude/Sonnet worker, Claude/Opus supervisor). Reuse the chat's `AgentGlyph` + `useAgentModels` + `useAgents`; do NOT re-install to change a running assistant (install applies the full config and would clobber live operator edits — Plan 2 review note).

**Architecture:** `apps/web` (pnpm, package `web`). React 19 + Vite + TypeScript, Tailwind v4, shadcn/ui primitives, TanStack Query v5 for mutations, Zustand `src/store/cluster.ts` for live cluster state fed by the WebSocket. Path alias `@/` → `apps/web/src`. The Assistant panel lives in `apps/web/src/panels/assistant/`:
- `AssistantContext.tsx` owns all cross-cutting state (the `tab` set, the `run(req)` action runner over `useAssistantAction`, dialogs). `TabKey` is the union of tab ids; `TabBar.tsx` renders `SegmentedTabs`; `TabContent.tsx` switches on `tab`.
- `useAssistant.ts` derives panel state from the cluster store. It already reads the `assistant-config` ConfigMap's `data` map for `enabled`/`mode`/`window`/`webhookUrl`/`silenced`/`alertRules` (see `AssistantDerived`). **This is the mechanism the new UI extends: read `workerProvider`/`workerModel`/`workerEffort`/`supervisorProvider`/`supervisorModel`/`supervisorEffort` + the limit keys from that same `configData` map and surface them on `AssistantDerived` (a new `roles` + `limits` field).**
- Patch actions: every control calls `ctx.run({ action, namespace, ... })` which fires `useAssistantAction()` → POST `/api/assistant`. The `AssistantRequest` type in `apps/web/src/lib/api.ts` ALREADY has `worker`/`supervisor` (`AssistantRoleSelection {provider, model, effort?}`), `credentials` (`AssistantCredentials`), `limits` (`AssistantLimits`), and the actions `setModels`/`setCredentials`/`setLimits`/`install` (Plan 2). The only additions in this plan are the `credentialStatus` action (a server READ, Tasks 6b/6c) on both the server and web `AssistantAction` unions, used to drive accurate credential-readiness chips — it returns credential key NAMES only, never secret values.

Reusable chat pieces:
- `AgentGlyph` from `apps/web/src/panels/settings/agents/agentGlyphs.tsx` — brand mark per `AgentId` (`claude|codex|gemini|opencode`).
- `useAgentModels(agentId)` from `@/lib/api` → `{ models: string[]; efforts: string[] }` (efforts non-empty for Claude only).
- `useAgents()` from `@/lib/api` → `{ agents: AgentView[] }`; `AgentView` carries `id`, `label`, `vendor`, `authMethods` — the single source of truth for the credentials-manager rows (vendor name + auth method label), so we do NOT hand-roll a provider metadata table.
- `effortName` / `modelName` from `apps/web/src/panels/chat/composerModel.ts` for pretty labels.

**Tech Stack:** React 19, TypeScript, Vitest 4 + @testing-library/react (`render`/`screen`) + jsdom (`// @vitest-environment jsdom` at the top of each component test, exactly like `apps/web/src/panels/settings/agents/AgentSetup.test.tsx`). Tests that touch `useAgents`/`useAgentModels` wrap the tree in a `QueryClientProvider` and stub `global.fetch`. Test command everywhere: `pnpm --filter web test <path>`. Typecheck: `pnpm --filter web typecheck`. Build: `pnpm --filter web build`. The codebase has NO shadcn `select` primitive — provider/model pickers reuse the existing `DropdownMenu` (`@/components/ui/dropdown-menu`, used by `InstallView`); the effort control reuses `SegmentedTabs` (`@/components/ui/SegmentedTabs`); confirmation uses `Dialog` (`@/components/ui/dialog`), matching the Assistant panel's existing dialogs (per the "Use Dialogs not Sheets" feedback). Mutations confirmed via the `ctx.run` path that already exists.

> **NOTE for the human (not a code step):** `docs/` is gitignored in this repo. This plan file is not tracked by a plain `git add`; to commit it later use `git add -f docs/superpowers/plans/2026-06-23-assistant-multi-provider-3-ui.md`.

## Contract reference (must match Plans 1 & 2's landed code exactly)

**assistant-config keys read from `useAssistant`'s `configData` map** (seeded by Plan 2's `configMaps`, written by `setModels`/`setLimits`):
- Roles: `workerProvider`, `workerModel`, `workerEffort`, `supervisorProvider`, `supervisorModel`, `supervisorEffort`.
- Limits: `pollIntervalMs`, `maxPerResourcePerHour`, `maxPerNight`, `maxAttemptsPerIncident`, `confirmPolls`, `namespaces` (newline-separated; "" = all).

**`AssistantRequest` fields used (already in `apps/web/src/lib/api.ts`):**
- `worker?: AssistantRoleSelection` / `supervisor?: AssistantRoleSelection` where `AssistantRoleSelection = { provider: string; model: string; effort?: string }`.
- `credentials?: AssistantCredentials = { claudeToken?, anthropicApiKey?, codexApiKey?, geminiApiKey?, opencodeApiKey?, opencodeAuthContent? }`.
- `limits?: AssistantLimits = { pollIntervalMs?, maxPerResourcePerHour?, maxPerNight?, maxAttemptsPerIncident?, confirmPolls?, namespaces?: string[] }`.
- Actions: `install`, `setModels`, `setCredentials`, `setLimits`.

**Provider → credential key map** (for the credentials manager: which Secret key a provider's pasted value goes into):
| AgentId | credential key(s) | auth label |
|---|---|---|
| `claude` | `claudeToken` (preferred) or `anthropicApiKey` | "Subscription token or API key" |
| `codex` | `codexApiKey` | "API key" |
| `gemini` | `geminiApiKey` | "API key" |
| `opencode` | `opencodeApiKey` | "API key" |

**Defaults (out-of-box, unchanged):** worker `claude` / `claude-sonnet-4-6`, supervisor `claude` / `claude-opus-4-8`.

---

## Task 1 — Provider/credential metadata helpers (pure, shared)

A tiny pure module the role picker, credentials manager, and InstallView all import, so the AgentId list, the provider→credential-key mapping, and the role defaults live in ONE place. No new provider names are invented — the four ids are the chat's `AgentId`; vendor/label/auth-method *display* still comes from `useAgents()` at render time. This module only owns the bits the server doesn't surface: which Secret key a provider writes to, and the role defaults.

**Files:**
- Create: `apps/web/src/panels/assistant/agents/providerMeta.ts`
- Create (test): `apps/web/src/panels/assistant/agents/providerMeta.test.ts`

**Steps:**

- [ ] Write the failing test `apps/web/src/panels/assistant/agents/providerMeta.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import {
  PROVIDER_IDS,
  DEFAULT_WORKER,
  DEFAULT_SUPERVISOR,
  credentialKeyFor,
  isClaudeFamily,
  credentialReady,
} from "./providerMeta";
import type { AssistantCredentials } from "@/lib/api";

describe("providerMeta", () => {
  test("the four provider ids in stable order", () => {
    expect(PROVIDER_IDS).toEqual(["claude", "codex", "gemini", "opencode"]);
  });

  test("role defaults match the out-of-box assistant", () => {
    expect(DEFAULT_WORKER).toEqual({ provider: "claude", model: "claude-sonnet-4-6", effort: "high" });
    expect(DEFAULT_SUPERVISOR).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: "high" });
  });

  test("credentialKeyFor maps a provider to its primary Secret key", () => {
    expect(credentialKeyFor("claude")).toBe("claudeToken");
    expect(credentialKeyFor("codex")).toBe("codexApiKey");
    expect(credentialKeyFor("gemini")).toBe("geminiApiKey");
    expect(credentialKeyFor("opencode")).toBe("opencodeApiKey");
  });

  test("isClaudeFamily is true only for claude (drives the effort control)", () => {
    expect(isClaudeFamily("claude")).toBe(true);
    expect(isClaudeFamily("gemini")).toBe(false);
  });

  test("credentialReady is true when ANY of a provider's keys is set", () => {
    const creds: AssistantCredentials = { anthropicApiKey: "sk-ant", geminiApiKey: "" };
    expect(credentialReady("claude", creds)).toBe(true); // anthropicApiKey is an alt claude key
    expect(credentialReady("codex", creds)).toBe(false);
    expect(credentialReady("gemini", { geminiApiKey: "g" })).toBe(true);
    expect(credentialReady("opencode", { opencodeAuthContent: "blob" })).toBe(true);
  });
});
```

- [ ] Run it, expect FAIL (module not found): `pnpm --filter web test src/panels/assistant/agents/providerMeta.test.ts`

- [ ] Create `apps/web/src/panels/assistant/agents/providerMeta.ts`:
```ts
// Pure provider metadata the Assistant Agents UI owns: the provider id list, the
// role defaults, and the provider→credential-key mapping. Vendor names, labels,
// and auth-method copy come from useAgents() at render time — this module only
// holds what the server does not surface.
import type { AgentId, AssistantCredentials, AssistantRoleSelection } from "@/lib/api";

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

/** Every credential Secret key a provider can authenticate with. */
const KEYS_FOR: Record<AgentId, (keyof AssistantCredentials)[]> = {
  claude: ["claudeToken", "anthropicApiKey"],
  codex: ["codexApiKey"],
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
```

- [ ] Run it, expect PASS: `pnpm --filter web test src/panels/assistant/agents/providerMeta.test.ts`

- [ ] Typecheck: `pnpm --filter web typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/web/src/panels/assistant/agents/providerMeta.ts apps/web/src/panels/assistant/agents/providerMeta.test.ts
git commit -m "feat(web): provider metadata helpers for the Assistant Agents UI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2 — `RolePicker` component (provider + model + effort)

A reusable controlled component: a provider DropdownMenu (brand glyph + label), a model DropdownMenu populated from `useAgentModels(provider)`, and a Low/Medium/High effort `SegmentedTabs` shown only for Claude-family providers. It is purely controlled (`value` + `onChange`) so both the Agents tab and InstallView drive it. Switching provider resets the model to the new provider's first model (so the selection is never a stale model from the old provider).

**Files:**
- Create: `apps/web/src/panels/assistant/agents/RolePicker.tsx`
- Create (test): `apps/web/src/panels/assistant/agents/RolePicker.test.tsx`

**Steps:**

- [ ] Write the failing test `apps/web/src/panels/assistant/agents/RolePicker.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RolePicker } from "./RolePicker";
import type { AssistantRoleSelection } from "@/lib/api";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  // useAgentModels(provider) → GET /api/agents/<id>/models
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/agents/claude/models")) {
      return new Response(JSON.stringify({ models: ["claude-sonnet-4-6", "claude-opus-4-8"], efforts: ["low", "medium", "high"] }));
    }
    if (url.includes("/api/agents/gemini/models")) {
      return new Response(JSON.stringify({ models: ["gemini-2.5-pro", "gemini-2.5-flash"], efforts: [] }));
    }
    return new Response(JSON.stringify({ models: [], efforts: [] }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

const claudeValue: AssistantRoleSelection = { provider: "claude", model: "claude-sonnet-4-6", effort: "high" };

describe("RolePicker", () => {
  it("renders the role label, description, current provider and model", async () => {
    wrap(<RolePicker label="Worker" description="Investigates incidents, proposes fixes" value={claudeValue} onChange={() => {}} />);
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText(/Investigates incidents/)).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(await screen.findByText("claude-sonnet-4-6")).toBeInTheDocument();
  });

  it("shows the reasoning-effort segment for Claude", async () => {
    wrap(<RolePicker label="Worker" description="d" value={claudeValue} onChange={() => {}} />);
    expect(await screen.findByRole("tab", { name: /low/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /medium/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /high/i })).toBeInTheDocument();
  });

  it("hides the effort segment for non-Claude providers", async () => {
    const gemini: AssistantRoleSelection = { provider: "gemini", model: "gemini-2.5-pro" };
    wrap(<RolePicker label="Worker" description="d" value={gemini} onChange={() => {}} />);
    await screen.findByText("gemini-2.5-pro");
    expect(screen.queryByRole("tab", { name: /low/i })).not.toBeInTheDocument();
  });

  it("emits a new selection with the first model when the provider changes", async () => {
    const onChange = vi.fn();
    wrap(<RolePicker label="Worker" description="d" value={claudeValue} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /provider/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /gemini/i }));
    // provider switched → model resets to gemini's first advertised model, effort cleared.
    expect(onChange).toHaveBeenCalledWith({ provider: "gemini", model: "gemini-2.5-pro" });
  });

  it("emits the chosen effort when an effort tab is clicked", async () => {
    const onChange = vi.fn();
    wrap(<RolePicker label="Worker" description="d" value={claudeValue} onChange={onChange} />);
    await userEvent.click(await screen.findByRole("tab", { name: /low/i }));
    expect(onChange).toHaveBeenCalledWith({ provider: "claude", model: "claude-sonnet-4-6", effort: "low" });
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter web test src/panels/assistant/agents/RolePicker.test.tsx`

- [ ] Create `apps/web/src/panels/assistant/agents/RolePicker.tsx`:
```tsx
// RolePicker — provider + model + reasoning-effort controls for one Assistant
// role (Worker or Supervisor). Controlled: value + onChange. Reuses the chat's
// AgentGlyph + useAgentModels so the choices match the chat exactly.
import { useEffect } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { AgentGlyph } from "@/panels/settings/agents/agentGlyphs";
import { useAgentModels, useAgents, type AgentId, type AssistantRoleSelection } from "@/lib/api";
import { Card, Field } from "../components/primitives";
import { PROVIDER_IDS, isClaudeFamily } from "./providerMeta";

/** Low/Medium/High only — the three the design exposes. */
const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

export function RolePicker({
  label,
  description,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  value: AssistantRoleSelection;
  onChange: (next: AssistantRoleSelection) => void;
  disabled?: boolean;
}) {
  const provider = value.provider as AgentId;
  const { data: agents } = useAgents();
  const { data: agentModels } = useAgentModels(provider);
  const models = agentModels?.models ?? [];

  const providerLabel = agents?.agents.find((a) => a.id === provider)?.label ?? provider;

  // If the current model isn't in this provider's advertised list, fall back to
  // the first advertised model (keeps the selection coherent after a switch).
  useEffect(() => {
    if (models.length > 0 && !models.includes(value.model)) {
      onChange({ provider, model: models[0]! });
    }
  }, [models, value.model, provider, onChange]);

  function pickProvider(next: AgentId) {
    if (next === provider) return;
    // Reset model + clear effort; the effect above will fill the model once the
    // new provider's models load (or we leave the current model if it loads in).
    onChange({ provider: next, model: value.model });
  }

  return (
    <Card className="space-y-2.5">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      <Field label="Provider" labelWidth="w-20">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
            className="flex flex-1 items-center justify-between rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            aria-label="Provider"
          >
            <span className="flex items-center gap-2">
              <AgentGlyph id={provider} size={16} />
              {providerLabel}
            </span>
            <ChevronDown className="size-4 shrink-0 text-primary" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {PROVIDER_IDS.map((id) => (
              <DropdownMenuItem key={id} onClick={() => pickProvider(id)}>
                <span className="flex items-center gap-2">
                  <AgentGlyph id={id} size={16} />
                  {agents?.agents.find((a) => a.id === id)?.label ?? id}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </Field>

      <Field label="Model" labelWidth="w-20">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled || models.length === 0}
            className="flex flex-1 items-center justify-between rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            aria-label="Model"
          >
            <span className="truncate">{value.model || "Select a model"}</span>
            <ChevronDown className="size-4 shrink-0 text-primary" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {models.map((m) => (
              <DropdownMenuItem key={m} onClick={() => onChange({ ...value, model: m })}>
                {m}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </Field>

      {isClaudeFamily(provider) && (
        <Field label="Reasoning" labelWidth="w-20">
          <SegmentedTabs
            tabs={EFFORTS}
            active={value.effort ?? "high"}
            onChange={(id) => onChange({ ...value, effort: id })}
          />
        </Field>
      )}
    </Card>
  );
}
```

- [ ] Run it, expect PASS: `pnpm --filter web test src/panels/assistant/agents/RolePicker.test.tsx`

- [ ] Typecheck: `pnpm --filter web typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/web/src/panels/assistant/agents/RolePicker.tsx apps/web/src/panels/assistant/agents/RolePicker.test.tsx
git commit -m "feat(web): RolePicker — provider/model/effort control for one Assistant role

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3 — `CredentialsManager` component (one row per provider)

A row per provider (brand glyph + vendor name + auth-method label + a status chip "Key ready"/"Not set" + an Add/Update inline input). Editing a row reveals a password input + Save that calls `onSave(provider, value)`; the parent (Agents tab in Task 6 / InstallView in Task 7) maps the value onto the right credential key via `credentialKeyFor` and decides whether to patch live (`setCredentials`, with confirmation) or stage it (install). It reuses `useAgents()` for the vendor/label/auth-method copy.

**Files:**
- Create: `apps/web/src/panels/assistant/agents/CredentialsManager.tsx`
- Create (test): `apps/web/src/panels/assistant/agents/CredentialsManager.test.tsx`

**Steps:**

- [ ] Write the failing test `apps/web/src/panels/assistant/agents/CredentialsManager.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CredentialsManager } from "./CredentialsManager";
import type { AssistantCredentials } from "@/lib/api";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/agents")) {
      return new Response(JSON.stringify({
        activeAgentId: "claude",
        agents: [
          { id: "claude", label: "Claude", vendor: "Anthropic", status: "available", connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription", installUrl: "x", installLabel: "i" },
          { id: "codex", label: "Codex", vendor: "OpenAI", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
          { id: "gemini", label: "Gemini", vendor: "Google", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
          { id: "opencode", label: "OpenCode", vendor: "SST", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
        ],
      }));
    }
    return new Response(JSON.stringify({ models: [], efforts: [] }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("CredentialsManager", () => {
  it("renders a row per provider with vendor + auth-method label", async () => {
    wrap(<CredentialsManager credentials={{}} onSave={() => {}} />);
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(screen.getByText("Subscription token or API key")).toBeInTheDocument();
    expect(screen.getAllByText("API key").length).toBeGreaterThanOrEqual(3);
  });

  it("shows 'Key ready' for a provider with a credential and 'Not set' otherwise", async () => {
    const creds: AssistantCredentials = { geminiApiKey: "g-1" };
    wrap(<CredentialsManager credentials={creds} onSave={() => {}} />);
    expect(await screen.findByText("Key ready")).toBeInTheDocument();
    expect(screen.getAllByText("Not set").length).toBeGreaterThanOrEqual(3);
  });

  it("notes the keys are stored as a Kubernetes Secret", async () => {
    wrap(<CredentialsManager credentials={{}} onSave={() => {}} />);
    expect(await screen.findByText(/Stored as a Kubernetes Secret/i)).toBeInTheDocument();
  });

  it("calls onSave(provider, value) when a key is entered and saved", async () => {
    const onSave = vi.fn();
    wrap(<CredentialsManager credentials={{}} onSave={onSave} />);
    // Open the Gemini row's inline editor.
    const geminiRow = (await screen.findByText("Gemini")).closest("[data-provider]") as HTMLElement;
    await userEvent.click(within(geminiRow).getByRole("button", { name: /add key/i }));
    await userEvent.type(within(geminiRow).getByPlaceholderText(/key/i), "g-secret");
    await userEvent.click(within(geminiRow).getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith("gemini", "g-secret");
  });
});

import { within } from "@testing-library/react";
```

- [ ] Run it, expect FAIL: `pnpm --filter web test src/panels/assistant/agents/CredentialsManager.test.tsx`

- [ ] Create `apps/web/src/panels/assistant/agents/CredentialsManager.tsx`:
```tsx
// CredentialsManager — one row per provider with a status chip + an inline
// Add/Update key editor. Vendor names + auth-method copy come from useAgents().
// onSave(provider, value) hands the raw pasted value to the parent, which maps it
// onto the right Secret key (credentialKeyFor) and patches or stages it.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AgentGlyph } from "@/panels/settings/agents/agentGlyphs";
import { useAgents, type AgentId, type AssistantCredentials } from "@/lib/api";
import { Card, inputClass } from "../components/primitives";
import { PROVIDER_IDS, credentialReady } from "./providerMeta";

/** Auth-method label: Claude can use a subscription token OR an API key; the rest are API-key only. */
function authLabel(id: AgentId): string {
  return id === "claude" ? "Subscription token or API key" : "API key";
}

export function CredentialsManager({
  credentials,
  onSave,
  disabled = false,
}: {
  credentials: AssistantCredentials;
  onSave: (provider: AgentId, value: string) => void;
  disabled?: boolean;
}) {
  const { data: agents } = useAgents();

  return (
    <Card className="space-y-2">
      <div>
        <p className="text-sm font-semibold">Credentials</p>
        <p className="text-xs text-muted-foreground">
          Stored as a Kubernetes Secret in the cluster. Only providers a role uses need a key.
        </p>
      </div>
      {PROVIDER_IDS.map((id) => (
        <CredentialRow
          key={id}
          id={id}
          label={agents?.agents.find((a) => a.id === id)?.label ?? id}
          ready={credentialReady(id, credentials)}
          onSave={(v) => onSave(id, v)}
          disabled={disabled}
        />
      ))}
    </Card>
  );
}

function CredentialRow({
  id,
  label,
  ready,
  onSave,
  disabled,
}: {
  id: AgentId;
  label: string;
  ready: boolean;
  onSave: (value: string) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  return (
    <div data-provider={id} className="rounded-md border p-2">
      <div className="flex items-center gap-2">
        <AgentGlyph id={id} size={18} />
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{authLabel(id)}</p>
        </div>
        <span
          className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
            ready
              ? "bg-green-500/15 text-green-600 dark:text-green-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {ready ? "Key ready" : "Not set"}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => setEditing((e) => !e)}
        >
          {ready ? "Update" : "Add key"}
        </Button>
      </div>
      {editing && (
        <div className="mt-2 flex gap-2">
          <input
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={id === "claude" ? "Token or API key" : "API key"}
            className={`w-full ${inputClass}`}
          />
          <Button
            size="sm"
            disabled={disabled || value.trim() === ""}
            onClick={() => {
              onSave(value.trim());
              setValue("");
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] Run it, expect PASS: `pnpm --filter web test src/panels/assistant/agents/CredentialsManager.test.tsx`

- [ ] Typecheck: `pnpm --filter web typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/web/src/panels/assistant/agents/CredentialsManager.tsx apps/web/src/panels/assistant/agents/CredentialsManager.test.tsx
git commit -m "feat(web): CredentialsManager — per-provider key rows for the Assistant

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4 — `LimitsForm` component (operational limits grid)

A controlled grid of labeled inputs for the six operational limits (poll interval, max per resource/hr, max per night, attempts per incident, confirm polls, monitor namespaces). Numeric inputs emit numbers; monitor-namespaces is a comma/newline list edited as text and emitted as a `string[]`. Controlled (`value: AssistantLimits` + `onChange`) so it serves both the Agents tab (live `setLimits`) and InstallView (staged install).

**Files:**
- Create: `apps/web/src/panels/assistant/agents/LimitsForm.tsx`
- Create (test): `apps/web/src/panels/assistant/agents/LimitsForm.test.tsx`

**Steps:**

- [ ] Write the failing test `apps/web/src/panels/assistant/agents/LimitsForm.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LimitsForm } from "./LimitsForm";
import type { AssistantLimits } from "@/lib/api";

const base: AssistantLimits = {
  pollIntervalMs: 30000,
  maxPerResourcePerHour: 3,
  maxPerNight: 10,
  maxAttemptsPerIncident: 2,
  confirmPolls: 2,
  namespaces: ["default"],
};

describe("LimitsForm", () => {
  it("renders all six labeled inputs with current values", () => {
    render(<LimitsForm value={base} onChange={() => {}} />);
    expect(screen.getByLabelText(/poll interval/i)).toHaveValue(30000);
    expect(screen.getByLabelText(/max per resource/i)).toHaveValue(3);
    expect(screen.getByLabelText(/max per night/i)).toHaveValue(10);
    expect(screen.getByLabelText(/attempts per incident/i)).toHaveValue(2);
    expect(screen.getByLabelText(/confirm polls/i)).toHaveValue(2);
    expect(screen.getByLabelText(/monitor namespaces/i)).toHaveValue("default");
  });

  it("emits a numeric value when a number field changes", async () => {
    const onChange = vi.fn();
    render(<LimitsForm value={base} onChange={onChange} />);
    const field = screen.getByLabelText(/confirm polls/i);
    await userEvent.clear(field);
    await userEvent.type(field, "4");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ confirmPolls: 4 }));
  });

  it("emits a string[] for monitor namespaces from a comma list", async () => {
    const onChange = vi.fn();
    render(<LimitsForm value={base} onChange={onChange} />);
    const field = screen.getByLabelText(/monitor namespaces/i);
    await userEvent.clear(field);
    await userEvent.type(field, "default, kube-system");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ namespaces: ["default", "kube-system"] }));
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter web test src/panels/assistant/agents/LimitsForm.test.tsx`

- [ ] Create `apps/web/src/panels/assistant/agents/LimitsForm.tsx`:
```tsx
// LimitsForm — the operational-limits grid. Controlled (value + onChange). Numbers
// emit numbers; monitor-namespaces is a comma/newline list emitted as string[].
import type { AssistantLimits } from "@/lib/api";
import { inputClass } from "../components/primitives";

const NUM_FIELDS: { key: keyof AssistantLimits; label: string }[] = [
  { key: "pollIntervalMs", label: "Poll interval (ms)" },
  { key: "maxPerResourcePerHour", label: "Max per resource / hr" },
  { key: "maxPerNight", label: "Max per night" },
  { key: "maxAttemptsPerIncident", label: "Attempts per incident" },
  { key: "confirmPolls", label: "Confirm polls" },
];

/** Parse a comma/newline list into a trimmed, non-empty string[]. */
function parseNamespaces(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function LimitsForm({
  value,
  onChange,
  disabled = false,
}: {
  value: AssistantLimits;
  onChange: (next: AssistantLimits) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {NUM_FIELDS.map(({ key, label }) => (
        <label key={key} className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          <input
            type="number"
            aria-label={label}
            disabled={disabled}
            value={(value[key] as number | undefined) ?? ""}
            onChange={(e) =>
              onChange({ ...value, [key]: e.target.value === "" ? undefined : Number(e.target.value) })
            }
            className={`w-full ${inputClass}`}
          />
        </label>
      ))}
      <label className="col-span-2 flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Monitor namespaces (blank = all)</span>
        <input
          type="text"
          aria-label="Monitor namespaces"
          disabled={disabled}
          value={(value.namespaces ?? []).join(", ")}
          onChange={(e) => onChange({ ...value, namespaces: parseNamespaces(e.target.value) })}
          className={`w-full ${inputClass}`}
        />
      </label>
    </div>
  );
}
```

- [ ] Run it, expect PASS: `pnpm --filter web test src/panels/assistant/agents/LimitsForm.test.tsx`

- [ ] Typecheck: `pnpm --filter web typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/web/src/panels/assistant/agents/LimitsForm.tsx apps/web/src/panels/assistant/agents/LimitsForm.test.tsx
git commit -m "feat(web): LimitsForm — operational-limits grid for the Assistant

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5 — Surface current role + limit values on `AssistantDerived`

The Agents tab must pre-fill its controls from the LIVE `assistant-config`. `useAssistant` already reads that ConfigMap's `data` map (`configData`) for `enabled`/`mode`/etc. Add a `roles` field (`{ worker, supervisor }` parsed from the role keys, falling back to the defaults) and a `limits` field (parsed from the limit keys) to `AssistantDerived`, computed from the same `configData`. This is the exact mechanism `RulesTab` uses (it reads `d.autonomyMode`/`d.quietWindow`).

**Files:**
- Modify: `apps/web/src/panels/assistant/useAssistant.ts` (the `AssistantDerived` interface ~lines 69-92; the `configData` block + the returned object ~lines 146, 174-204)
- Create (test): `apps/web/src/panels/assistant/useAssistant.roles.test.ts`

**Steps:**

- [ ] Write the failing test `apps/web/src/panels/assistant/useAssistant.roles.test.ts` (a pure-function test on a small exported parser, so no store wiring is needed):
```ts
import { describe, expect, test } from "vitest";
import { parseRolesFromConfig, parseLimitsFromConfig } from "./useAssistant";

describe("parseRolesFromConfig", () => {
  test("reads both roles from the assistant-config keys", () => {
    const roles = parseRolesFromConfig({
      workerProvider: "gemini", workerModel: "gemini-2.5-pro",
      supervisorProvider: "claude", supervisorModel: "claude-opus-4-8", supervisorEffort: "high",
    });
    expect(roles.worker).toEqual({ provider: "gemini", model: "gemini-2.5-pro" });
    expect(roles.supervisor).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: "high" });
  });

  test("falls back to the Claude defaults when no role keys are present", () => {
    const roles = parseRolesFromConfig({});
    expect(roles.worker).toEqual({ provider: "claude", model: "claude-sonnet-4-6", effort: "high" });
    expect(roles.supervisor).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: "high" });
  });
});

describe("parseLimitsFromConfig", () => {
  test("reads + coerces the limit keys, splitting namespaces on newlines", () => {
    const limits = parseLimitsFromConfig({
      pollIntervalMs: "45000", confirmPolls: "4", namespaces: "default\nkube-system",
    });
    expect(limits.pollIntervalMs).toBe(45000);
    expect(limits.confirmPolls).toBe(4);
    expect(limits.namespaces).toEqual(["default", "kube-system"]);
  });

  test("empty namespaces string → empty array (all namespaces)", () => {
    expect(parseLimitsFromConfig({ namespaces: "" }).namespaces).toEqual([]);
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter web test src/panels/assistant/useAssistant.roles.test.ts`

- [ ] Edit `apps/web/src/panels/assistant/useAssistant.ts`. Add the imports + types near the top imports (after the `@rigel/k8s` import block, ~line 23):
```ts
import type { AssistantRoleSelection, AssistantLimits } from "@/lib/api";
import { DEFAULT_WORKER, DEFAULT_SUPERVISOR } from "./agents/providerMeta";
```

- [ ] Add the two exported pure parsers near the bottom of the file (after `useAssistant`):
```ts
/** Parse the per-role selections from the assistant-config data map, defaulting
 *  to the out-of-box Claude worker/supervisor when no role keys are present. */
export function parseRolesFromConfig(
  data: Record<string, string>,
): { worker: AssistantRoleSelection; supervisor: AssistantRoleSelection } {
  const role = (
    p: string | undefined,
    m: string | undefined,
    e: string | undefined,
    fallback: AssistantRoleSelection,
  ): AssistantRoleSelection => {
    if (!p && !m) return fallback;
    return {
      provider: p ?? fallback.provider,
      model: m ?? fallback.model,
      ...(e ? { effort: e } : {}),
    };
  };
  return {
    worker: role(data.workerProvider, data.workerModel, data.workerEffort, DEFAULT_WORKER),
    supervisor: role(
      data.supervisorProvider,
      data.supervisorModel,
      data.supervisorEffort,
      DEFAULT_SUPERVISOR,
    ),
  };
}

/** Parse the operational limits from the assistant-config data map (numbers
 *  coerced; namespaces split on commas/newlines; absent keys omitted). */
export function parseLimitsFromConfig(data: Record<string, string>): AssistantLimits {
  const num = (v: string | undefined): number | undefined =>
    v === undefined || v.trim() === "" ? undefined : Number(v);
  const limits: AssistantLimits = {};
  if (data.pollIntervalMs !== undefined) limits.pollIntervalMs = num(data.pollIntervalMs);
  if (data.maxPerResourcePerHour !== undefined) limits.maxPerResourcePerHour = num(data.maxPerResourcePerHour);
  if (data.maxPerNight !== undefined) limits.maxPerNight = num(data.maxPerNight);
  if (data.maxAttemptsPerIncident !== undefined) limits.maxAttemptsPerIncident = num(data.maxAttemptsPerIncident);
  if (data.confirmPolls !== undefined) limits.confirmPolls = num(data.confirmPolls);
  if (data.namespaces !== undefined) {
    limits.namespaces = data.namespaces.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  }
  return limits;
}
```

- [ ] Extend the `AssistantDerived` interface (after `alertRules: AlertRule[];`, ~line 91):
```ts
  /** Per-role provider/model/effort, parsed from assistant-config (defaults applied). */
  roles: { worker: AssistantRoleSelection; supervisor: AssistantRoleSelection };
  /** Operational limits parsed from assistant-config (absent keys omitted). */
  limits: AssistantLimits;
```

- [ ] In the returned object inside `useAssistant` (after `alertRules: parseAlertRules(configData["alertRules"]),`, ~line 203):
```ts
      roles: parseRolesFromConfig(configData),
      limits: parseLimitsFromConfig(configData),
```

- [ ] Run it, expect PASS: `pnpm --filter web test src/panels/assistant/useAssistant.roles.test.ts`

- [ ] Typecheck: `pnpm --filter web typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/web/src/panels/assistant/useAssistant.ts apps/web/src/panels/assistant/useAssistant.roles.test.ts
git commit -m "feat(web): surface live role + limit values from assistant-config on AssistantDerived

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6 — `AgentsTab` — the management surface (reads live config, patches live)

The new tab that composes the three components for an installed assistant. It seeds each control from `d.roles` / `d.limits` (Task 5), and saves via the LIVE patch actions: `setModels` for a role change, `setLimits` for limits, `setCredentials` for a key. Because `setCredentials` rollout-restarts the agent, it goes through a confirmation Dialog first (per `apps/CLAUDE.md` confirm-before-mutate). Role/limit changes are live (no restart) and apply on the next poll.

**Files:**
- Create: `apps/web/src/panels/assistant/tabs/AgentsTab.tsx`
- Create (test): `apps/web/src/panels/assistant/tabs/AgentsTab.test.tsx`

**Steps:**

- [ ] Write the failing test `apps/web/src/panels/assistant/tabs/AgentsTab.test.tsx`. It mounts a real `AssistantContext` value via a tiny test provider so it can assert the `run(...)` calls (the action runner), exactly mirroring how the panel calls actions:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentsTab } from "./AgentsTab";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";
import type { AssistantDerived } from "../useAssistant";

const run = vi.fn();

function derived(overrides: Partial<AssistantDerived> = {}): AssistantDerived {
  return {
    roles: {
      worker: { provider: "claude", model: "claude-sonnet-4-6", effort: "high" },
      supervisor: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
    },
    limits: { pollIntervalMs: 30000, confirmPolls: 2, namespaces: ["default"] },
    ...overrides,
  } as AssistantDerived;
}

function ctx(d: AssistantDerived): AssistantContextValue {
  return { d, ns: "default", working: false, run } as unknown as AssistantContextValue;
}

function wrap(d = derived()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssistantContext value={ctx(d)}>
        <AgentsTab />
      </AssistantContext>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  run.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/agents/claude/models")) return new Response(JSON.stringify({ models: ["claude-sonnet-4-6", "claude-opus-4-8"], efforts: ["low", "medium", "high"] }));
    if (url.includes("/api/agents")) return new Response(JSON.stringify({ activeAgentId: "claude", agents: [
      { id: "claude", label: "Claude", vendor: "Anthropic", status: "available", connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription", installUrl: "x", installLabel: "i" },
      { id: "codex", label: "Codex", vendor: "OpenAI", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
      { id: "gemini", label: "Gemini", vendor: "Google", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
      { id: "opencode", label: "OpenCode", vendor: "SST", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
    ] }));
    return new Response(JSON.stringify({ models: [], efforts: [] }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("AgentsTab", () => {
  it("renders the header, the two role cards, and the live-vs-restart note", async () => {
    wrap();
    expect(screen.getByText("Agents & providers")).toBeInTheDocument();
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText("Supervisor")).toBeInTheDocument();
    expect(await screen.findByText(/Model changes apply on the next poll/i)).toBeInTheDocument();
  });

  it("saves a role change via setModels (live, no restart)", async () => {
    wrap();
    await screen.findAllByText("claude-sonnet-4-6");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      action: "setModels",
      namespace: "default",
      worker: expect.objectContaining({ provider: "claude" }),
      supervisor: expect.objectContaining({ provider: "claude" }),
    }));
  });

  it("saving a credential confirms (rollout-restart) then calls setCredentials", async () => {
    wrap();
    const geminiRow = (await screen.findByText("Gemini")).closest("[data-provider]") as HTMLElement;
    await userEvent.click(within(geminiRow).getByRole("button", { name: /add key/i }));
    await userEvent.type(within(geminiRow).getByPlaceholderText(/key/i), "g-secret");
    await userEvent.click(within(geminiRow).getByRole("button", { name: /^save$/i }));
    // A confirm dialog explains the restart; confirm it.
    await userEvent.click(await screen.findByRole("button", { name: /save & restart/i }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      action: "setCredentials",
      namespace: "default",
      credentials: { geminiApiKey: "g-secret" },
    }));
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter web test src/panels/assistant/tabs/AgentsTab.test.tsx`

- [ ] Create `apps/web/src/panels/assistant/tabs/AgentsTab.tsx`:
```tsx
// AgentsTab — manage the installed Assistant's providers, models, credentials, and
// operational limits. Pre-fills from the LIVE assistant-config (d.roles/d.limits)
// and patches LIVE: setModels (roles), setLimits (limits), setCredentials (keys,
// confirmed because it rollout-restarts the agent). Never re-installs.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { AgentId, AssistantLimits, AssistantRoleSelection } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Section } from "../components/primitives";
import { RolePicker } from "../agents/RolePicker";
import { CredentialsManager } from "../agents/CredentialsManager";
import { LimitsForm } from "../agents/LimitsForm";
import { credentialKeyFor } from "../agents/providerMeta";

export function AgentsTab() {
  const { d, ns, working, run } = useAssistantCtx();

  const [worker, setWorker] = useState<AssistantRoleSelection>(d.roles.worker);
  const [supervisor, setSupervisor] = useState<AssistantRoleSelection>(d.roles.supervisor);
  const [limits, setLimits] = useState<AssistantLimits>(d.limits);
  // The credential being staged behind the confirm dialog (it rolls the agent).
  const [pendingCred, setPendingCred] = useState<{ provider: AgentId; value: string } | null>(null);

  // Re-seed from live config when it changes (parity with RulesTab's effect).
  useEffect(() => {
    setWorker(d.roles.worker);
    setSupervisor(d.roles.supervisor);
  }, [d.roles.worker, d.roles.supervisor]);
  useEffect(() => setLimits(d.limits), [d.limits]);

  function saveRolesAndLimits() {
    run({ action: "setModels", namespace: ns, worker, supervisor });
    run({ action: "setLimits", namespace: ns, limits });
  }

  function confirmCredential() {
    if (!pendingCred) return;
    const key = credentialKeyFor(pendingCred.provider);
    run({ action: "setCredentials", namespace: ns, credentials: { [key]: pendingCred.value } });
    setPendingCred(null);
  }

  return (
    <div className="space-y-3.5">
      <div>
        <p className="text-sm font-semibold">Agents &amp; providers</p>
        <p className="text-xs text-muted-foreground">
          Pick which AI runs each role of the Assistant. Model changes apply on the next poll; adding
          a credential restarts the agent.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <RolePicker
          label="Worker"
          description="Investigates incidents, proposes fixes"
          value={worker}
          onChange={setWorker}
          disabled={working}
        />
        <RolePicker
          label="Supervisor"
          description="Adversarially reviews risky actions"
          value={supervisor}
          onChange={setSupervisor}
          disabled={working}
        />
      </div>

      <CredentialsManager
        credentials={d.creds ?? {}}
        onSave={(provider, value) => setPendingCred({ provider, value })}
        disabled={working}
      />

      <Section title="Operational limits">
        <Card>
          <LimitsForm value={limits} onChange={setLimits} disabled={working} />
        </Card>
      </Section>

      <div className="flex items-center justify-between border-t pt-3">
        <p className="text-xs text-muted-foreground">
          Model and limit changes are live (next poll). Credential changes restart the agent.
        </p>
        <Button disabled={working} onClick={saveRolesAndLimits}>
          Save changes
        </Button>
      </div>

      {/* Confirm a credential change (it rollout-restarts the agent). */}
      <Dialog open={!!pendingCred} onOpenChange={(o) => !o && setPendingCred(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save credential and restart the agent?</DialogTitle>
            <DialogDescription>
              Saving this key updates the cluster Secret and rolls the agent pod so it picks up the
              new credential. In-flight work is interrupted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingCred(null)}>
              Cancel
            </Button>
            <Button onClick={confirmCredential}>Save &amp; restart</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```
> NOTE: `d.creds` is the credential-readiness view surfaced on `AssistantDerived` by Tasks 6b/6c below — accurate, sourced from the server's `credentialStatus` read (which returns credential key NAMES only, never values). The shared `credentialReady(d.creds, provider)` helper drives each chip; after a `setCredentials` save the status query is invalidated so chips refresh. The `CredentialsManager` also reflects an in-session save via the `pendingCred`→confirm→`run` flow.

- [ ] Run it, expect PASS: `pnpm --filter web test src/panels/assistant/tabs/AgentsTab.test.tsx`

- [ ] Typecheck: `pnpm --filter web typecheck` (expect PASS — `d.creds: AssistantCredentials` is added to `AssistantDerived` in Task 6c; if you implement Task 6 before 6c, temporarily treat `d.creds` as possibly-undefined)

- [ ] Commit:
```
git add apps/web/src/panels/assistant/tabs/AgentsTab.tsx apps/web/src/panels/assistant/tabs/AgentsTab.test.tsx
git commit -m "feat(web): AgentsTab — manage roles/credentials/limits via live patch actions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6b — server: `credentialStatus` action reports present credential key NAMES (never values)

The credential chips must reflect which providers ALREADY have a key for a returning operator. The cluster store only watches Secret *metadata* (not data), so the client can't learn this from the store. But the web server runs kubectl with the OPERATOR's kubeconfig (via the `kubectl(context, args)` helper this file already uses for reads), which CAN read Secret data — so a one-shot server read returns the present credential **key names**. **Absolute security rule: only key NAMES ever leave the server. Secret VALUES are never returned to the client, never logged.** The base64 values are present transiently only to enumerate `Object.keys` and are immediately discarded.

**Files:**
- Modify: `apps/server/src/assistant.ts` (the `AssistantAction` union; a pure `normalizeCredentialKeys` helper; a `credentialStatus` reader; the `handleAssistant` dispatch ~line 485-521)
- Modify (test): `apps/server/src/assistant.test.ts`

**Steps:**

- [ ] Write the failing test (pure mapping helper — no live cluster, per the no-mutation/no-live-read test policy) in `apps/server/src/assistant.test.ts`:
```ts
import { normalizeCredentialKeys } from "./assistant.js";

describe("normalizeCredentialKeys", () => {
  test("keeps known credential keys, drops unknown ones", () => {
    expect(normalizeCredentialKeys(["geminiApiKey", "codexApiKey", "junk"], []).sort()).toEqual([
      "codexApiKey", "geminiApiKey",
    ]);
  });
  test("the legacy token Secret's `token` key maps to claudeToken", () => {
    expect(normalizeCredentialKeys([], ["token"])).toEqual(["claudeToken"]);
  });
  test("dedupes when both the legacy token and an explicit claudeToken are present", () => {
    expect(normalizeCredentialKeys(["claudeToken"], ["token"])).toEqual(["claudeToken"]);
  });
  test("no keys → empty", () => {
    expect(normalizeCredentialKeys([], [])).toEqual([]);
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @rigel/server test src/assistant.test.ts`

- [ ] Add the pure helper to `apps/server/src/assistant.ts` (near `parseCredentials`):
```ts
/** Credential key names the agent understands (match the bridges' authEnv()). */
const KNOWN_CREDENTIAL_KEYS: readonly string[] = [
  "claudeToken", "anthropicApiKey", "codexApiKey", "geminiApiKey",
  "opencodeApiKey", "opencodeAuthContent",
];

/** Map the present Secret key NAMES (from the credentials Secret + the legacy token
 *  Secret) to the normalized credential vocabulary the UI consumes. The legacy `token`
 *  key counts as `claudeToken`; unknown keys are dropped. Handles NAMES only — never
 *  secret values. */
export function normalizeCredentialKeys(credsKeys: string[], legacyKeys: string[]): string[] {
  const present = new Set<string>();
  for (const k of credsKeys) if (KNOWN_CREDENTIAL_KEYS.includes(k)) present.add(k);
  if (legacyKeys.includes("token")) present.add("claudeToken");
  return [...present];
}
```

- [ ] Add `"credentialStatus"` to the `AssistantAction` union (alongside the other actions).

- [ ] Add the reader (mirrors `readConfigMapData`'s use of the read-only `kubectl(context, args)` helper; returns a `RunResult` carrying JSON in `stdout`, exactly like the existing state-read cases at ~lines 456-470):
```ts
/** Report which credential key NAMES exist (never the values) across the credentials
 *  Secret + the legacy token Secret, for the UI's readiness chips. */
async function credentialStatus(context: string | null, namespace: string): Promise<RunResult> {
  const keysOf = async (secret: string): Promise<string[]> => {
    const res = await kubectl(context, ["get", "secret", secret, "-n", namespace, "-o", "json"]);
    if (res.code !== 0) return []; // not found / no access → no keys
    try {
      const obj = JSON.parse(res.stdout) as { data?: Record<string, unknown> };
      return Object.keys(obj.data ?? {}); // key NAMES only — values discarded here
    } catch {
      return [];
    }
  };
  const [credsKeys, legacyKeys] = await Promise.all([
    keysOf(CREDENTIALS_SECRET_NAME),
    keysOf(SECRET_NAME),
  ]);
  return {
    code: 0,
    stdout: JSON.stringify({ credentialKeys: normalizeCredentialKeys(credsKeys, legacyKeys) }),
    stderr: "",
  };
}
```
> Do NOT log `res.stdout` from these reads (it contains base64 secret values). Only the enumerated key names are returned.

- [ ] Add the dispatch case to `handleAssistant` (with the other read-ish cases):
```ts
    case "credentialStatus":
      return credentialStatus(context, namespace);
```

- [ ] Run it, expect PASS: `pnpm --filter @rigel/server test src/assistant.test.ts`

- [ ] Typecheck: `pnpm --filter @rigel/server typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/server/src/assistant.ts apps/server/src/assistant.test.ts
git commit -m "feat(server): credentialStatus action reports present credential key names (never values)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6c — web: query credentialStatus → accurate `creds` on `AssistantDerived`

Feed the chips from the server read (Task 6b) instead of a stub. Add `"credentialStatus"` to the web `AssistantAction` union, a pure `credsFromSecretKeys` helper (key names → `AssistantCredentials`, so the existing `credentialReady(creds, provider)` works), and a TanStack query in `useAssistant` that POSTs `credentialStatus` and surfaces `d.creds`. After `setCredentials` succeeds, the query is invalidated so chips refresh. **No secret values ever reach the client — the server returns only key names.**

**Files:**
- Modify: `apps/web/src/lib/api.ts` (add `"credentialStatus"` to the `AssistantAction` union; export the request helper if it isn't already — see below)
- Modify: `apps/web/src/panels/assistant/useAssistant.ts` (`credsFromSecretKeys`, the credential-status query, `AssistantDerived.creds`, the returned object)
- Modify (test): `apps/web/src/panels/assistant/useAssistant.roles.test.ts`

**Steps:**

- [ ] Add `"credentialStatus"` to the `AssistantAction` union in `apps/web/src/lib/api.ts` (one member, matching the server). Confirm there's a reusable request function the mutation uses (e.g. `useAssistantAction` posts `req` to `/api/assistant` and returns the parsed `RunResult`). If that POST is inline in the mutation, factor it into an exported `postAssistant(req: AssistantRequest): Promise<RunResult>` so the query below can reuse the exact same request path (same endpoint, headers, error handling). No other api.ts change.

- [ ] Append the failing test to `apps/web/src/panels/assistant/useAssistant.roles.test.ts`:
```ts
import { credsFromSecretKeys } from "./useAssistant";

describe("credsFromSecretKeys", () => {
  test("maps present Secret key NAMES to an AssistantCredentials presence view", () => {
    expect(credsFromSecretKeys(["geminiApiKey", "claudeToken"])).toEqual({
      geminiApiKey: "set",
      claudeToken: "set",
    });
  });
  test("no keys → empty (all chips read Not set)", () => {
    expect(credsFromSecretKeys([])).toEqual({});
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter web test src/panels/assistant/useAssistant.roles.test.ts`

- [ ] Add the exported helper to `apps/web/src/panels/assistant/useAssistant.ts` (near the other parsers; fold `AssistantCredentials` into the Task-5 `@/lib/api` type import line):
```ts
/** Build the presence view from the credential key NAMES the server reported (values
 *  never reach the client). Each present key gets a non-empty sentinel so the shared
 *  credentialReady(creds, provider) helper reports that provider ready. */
export function credsFromSecretKeys(keys: string[]): AssistantCredentials {
  const out: AssistantCredentials = {};
  for (const k of keys) (out as Record<string, string>)[k] = "set";
  return out;
}
```

- [ ] Run it, expect PASS: `pnpm --filter web test src/panels/assistant/useAssistant.roles.test.ts`

- [ ] Add the `creds` field to `AssistantDerived` (after the `limits` field from Task 5):
```ts
  /** Per-provider credential readiness, from the server's credentialStatus read
   *  (key names only — values never leave the cluster). */
  creds: AssistantCredentials;
```

- [ ] In `useAssistant`, fetch the status with a query and surface it (reuses `postAssistant` from the first step; `useQuery` is already used elsewhere in the app). Add near the top of the hook body and in the returned object:
```ts
  const credStatus = useQuery({
    queryKey: ["assistant-credentialStatus", installNamespace],
    queryFn: async () => {
      const res = await postAssistant({ action: "credentialStatus", namespace: installNamespace });
      const parsed = JSON.parse(res.stdout || "{}") as { credentialKeys?: string[] };
      return parsed.credentialKeys ?? [];
    },
  });
```
```ts
      creds: credsFromSecretKeys(credStatus.data ?? []),
```
> Import `useQuery` from `@tanstack/react-query` and `postAssistant` from `@/lib/api` at the top of `useAssistant.ts`. Use the hook's existing namespace variable for the key/arg (match what the rest of the hook uses — `installNamespace` here is illustrative; use the real one).

- [ ] Invalidate the query after a successful credential save so the chips update without a reload. Where the credential add/update is dispatched (the `AgentsTab`/`CredentialsManager` `setCredentials` handler from Task 3/6), after the `ctx.run({ action: "setCredentials", ... })` resolves, call `queryClient.invalidateQueries({ queryKey: ["assistant-credentialStatus", namespace] })` (grab `queryClient` via `useQueryClient()`). An optimistic flip of the just-added provider's chip is optional.

- [ ] Typecheck: `pnpm --filter web typecheck` (expect PASS)

- [ ] Run the web suite, expect PASS: `pnpm --filter web test src/panels/assistant`

- [ ] Commit:
```
git add apps/web/src/lib/api.ts apps/web/src/panels/assistant/useAssistant.ts apps/web/src/panels/assistant/useAssistant.roles.test.ts
git commit -m "feat(web): accurate credential readiness via the credentialStatus server read

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7 — InstallView collects role selections + credentials

Extend the fresh-install form so it gathers the two role selections (defaulting to Claude/Sonnet + Claude/Opus, unchanged out-of-box) and the credentials for the chosen providers, calling `install` with `worker`/`supervisor`/`credentials`/`limits`. The existing token field stays as the Claude path (it folds into `credentials.claudeToken`), so the default Claude-only install behaves exactly as today.

**Files:**
- Modify: `apps/web/src/panels/assistant/tabs/InstallView.tsx` (form state + `doInstall`, lines 36-107; insert the new cards before "3. Review manifests", line 213)
- Modify (test): create `apps/web/src/panels/assistant/tabs/InstallView.test.tsx`

**Steps:**

- [ ] Write the failing test `apps/web/src/panels/assistant/tabs/InstallView.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InstallView } from "./InstallView";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";

const run = vi.fn();

function ctx(): AssistantContextValue {
  return {
    d: { allNamespaceNames: ["default"], roles: { worker: { provider: "claude", model: "claude-sonnet-4-6", effort: "high" }, supervisor: { provider: "claude", model: "claude-opus-4-8", effort: "high" } }, limits: {} },
    working: false,
    run,
    actionError: null,
    installNamespace: "default",
    setInstallNamespace: vi.fn(),
    openConfirmCreateNs: (doInstall: () => void) => doInstall(),
  } as unknown as AssistantContextValue;
}

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssistantContext value={ctx()}>
        <InstallView />
      </AssistantContext>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  run.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/chat-config")) return new Response(JSON.stringify({ configured: false, source: null }));
    if (url.includes("/api/agents/claude/models")) return new Response(JSON.stringify({ models: ["claude-sonnet-4-6", "claude-opus-4-8"], efforts: ["low", "medium", "high"] }));
    if (url.includes("/api/agents")) return new Response(JSON.stringify({ activeAgentId: "claude", agents: [
      { id: "claude", label: "Claude", vendor: "Anthropic", status: "available", connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription", installUrl: "x", installLabel: "i" },
      { id: "codex", label: "Codex", vendor: "OpenAI", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
      { id: "gemini", label: "Gemini", vendor: "Google", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
      { id: "opencode", label: "OpenCode", vendor: "SST", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
    ] }));
    return new Response(JSON.stringify({ models: [], efforts: [] }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("InstallView (multi-provider)", () => {
  it("renders the role pickers defaulting to Claude worker/supervisor", async () => {
    wrap();
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText("Supervisor")).toBeInTheDocument();
    expect(await screen.findAllByText("claude-sonnet-4-6")).toBeTruthy();
  });

  it("installs with worker/supervisor selections + a pasted token folded into credentials", async () => {
    wrap();
    await screen.findAllByText("claude-sonnet-4-6");
    await userEvent.type(screen.getByPlaceholderText(/CLAUDE_CODE_OAUTH_TOKEN/i), "tok-abc");
    await userEvent.click(screen.getByRole("button", { name: /^install$/i }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "install",
        worker: expect.objectContaining({ provider: "claude", model: "claude-sonnet-4-6" }),
        supervisor: expect.objectContaining({ provider: "claude", model: "claude-opus-4-8" }),
        credentials: expect.objectContaining({ claudeToken: "tok-abc" }),
      }),
      expect.any(Function),
    );
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter web test src/panels/assistant/tabs/InstallView.test.tsx`

- [ ] Edit `apps/web/src/panels/assistant/tabs/InstallView.tsx`. Add imports near the top:
```ts
import type { AgentId, AssistantCredentials, AssistantRoleSelection } from "@/lib/api";
import { RolePicker } from "../agents/RolePicker";
import { DEFAULT_WORKER, DEFAULT_SUPERVISOR, credentialKeyFor } from "../agents/providerMeta";
```

- [ ] Add the role/credential local state next to the existing `useState` calls (after `const [showManifest, setShowManifest] = useState(false);`):
```ts
  const [worker, setWorker] = useState<AssistantRoleSelection>(DEFAULT_WORKER);
  const [supervisor, setSupervisor] = useState<AssistantRoleSelection>(DEFAULT_SUPERVISOR);
  // Staged credentials gathered for the providers the user chooses (besides the
  // Claude token, which uses the existing token field and folds into claudeToken).
  const [stagedCreds, setStagedCreds] = useState<AssistantCredentials>({});
  function stageCred(provider: AgentId, value: string) {
    setStagedCreds((c) => ({ ...c, [credentialKeyFor(provider)]: value }));
  }
```

- [ ] Replace the `run({ action: "install", ... })` payload inside `doInstall` (lines 90-99) to carry the selections + credentials:
```ts
    const credentials: AssistantCredentials = { ...stagedCreds };
    if (token !== "") credentials.claudeToken = token;
    run(
      {
        action: "install",
        namespace,
        token, // legacy field kept; server also folds it into credentials.claudeToken
        image,
        monitorNamespaces: config.namespaces,
        worker,
        supervisor,
        credentials,
      },
      () => {
        setInstallToken("");
        setStagedCreds({});
      },
    );
```

- [ ] Insert a new card with the two role pickers + a small per-provider credential note BEFORE the "3. Review manifests" card (line 213). The credential for a non-Claude chosen provider is collected by a `CredentialsManager` limited to the providers the roles use; to keep this pass simple, reuse the full `CredentialsManager` so the user can supply any provider's key during install:
```tsx
      <Card className="space-y-3">
        <p className="text-sm font-semibold">2b. Agents &amp; providers</p>
        <p className="text-xs text-muted-foreground">
          Pick which AI runs each role. Defaults to Claude. Add a key for any non-Claude provider you
          choose.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <RolePicker label="Worker" description="Investigates incidents, proposes fixes" value={worker} onChange={setWorker} disabled={working} />
          <RolePicker label="Supervisor" description="Adversarially reviews risky actions" value={supervisor} onChange={setSupervisor} disabled={working} />
        </div>
        <CredentialsManager credentials={stagedCreds} onSave={stageCred} disabled={working} />
      </Card>
```
> Add the `CredentialsManager` import alongside the others. The existing "1. Subscription token" card stays as the Claude path; a Claude-only install is unchanged.

- [ ] Run it, expect PASS: `pnpm --filter web test src/panels/assistant/tabs/InstallView.test.tsx`

- [ ] Run the whole assistant suite, expect PASS: `pnpm --filter web test src/panels/assistant`

- [ ] Typecheck: `pnpm --filter web typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/web/src/panels/assistant/tabs/InstallView.tsx apps/web/src/panels/assistant/tabs/InstallView.test.tsx
git commit -m "feat(web): InstallView collects role selections + credentials for a fresh install

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8 — Wire the Agents tab into the panel (TabKey, TabBar, TabContent)

Add `"agents"` to the tab set so the new surface appears in the installed assistant. It sits between Rules and Settings (it is a configuration surface like Rules). The token-update card already in SettingsTab stays (it remains the quick "rotate the Claude token after a 401" path), but the broader credential/provider management now lives in the Agents tab.

**Files:**
- Modify: `apps/web/src/panels/assistant/AssistantContext.tsx` (`TabKey` union, line 33)
- Modify: `apps/web/src/panels/assistant/components/TabBar.tsx` (the `tabs` array, lines 40-46)
- Modify: `apps/web/src/panels/assistant/components/TabContent.tsx` (import + switch, lines 7-12, 44-55; the `needsState` line 29)
- Modify (test): `apps/web/src/panels/assistant/components/TabBar.test.tsx` (create if absent; otherwise extend)

**Steps:**

- [ ] Write the failing test `apps/web/src/panels/assistant/components/TabBar.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TabBar } from "./TabBar";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";

function wrap(value: Partial<AssistantContextValue>) {
  return render(
    <AssistantContext value={{ setTab: vi.fn(), tab: "overview", ...value } as AssistantContextValue}>
      <TabBar />
    </AssistantContext>,
  );
}

describe("TabBar", () => {
  it("includes an Agents tab when installed", () => {
    wrap({
      phase: "ready",
      d: { ready: { state: true }, clusterState: { audit: [], queue: [] }, liveIssues: [] } as never,
    });
    expect(screen.getByRole("tab", { name: /agents/i })).toBeInTheDocument();
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter web test src/panels/assistant/components/TabBar.test.tsx`

- [ ] In `apps/web/src/panels/assistant/AssistantContext.tsx`, extend `TabKey` (line 33):
```ts
export type TabKey = "overview" | "needs" | "rules" | "agents" | "activity" | "settings";
```

- [ ] In `apps/web/src/panels/assistant/components/TabBar.tsx`, add the tab to the `tabs` array (after the `rules` entry):
```ts
    { id: "rules", label: "Rules" },
    { id: "agents", label: "Agents" },
    { id: "activity", label: "Activity", badge: activityBadge },
```
> Also bump the loading-skeleton bar count from 5 to 6 (line 19's `[1, 2, 3, 4, 5]` → `[1, 2, 3, 4, 5, 6]`) so the skeleton matches the new tab count.

- [ ] In `apps/web/src/panels/assistant/components/TabContent.tsx`, import + render `AgentsTab`:
```ts
import { AgentsTab } from "../tabs/AgentsTab";
```
Add to the switch (after the `rules` case):
```ts
    case "agents":
      return <AgentsTab />;
```
> `AgentsTab` reads roles/limits/creds from `d` (always present once installed) and `useAgents`/`useAgentModels` (their own loading states), so it does NOT need `ready.state`. Leave the `needsState` line as-is (do NOT add `"agents"` to it) so the tab renders immediately on install instead of waiting for the agent's first state report.

- [ ] Run it, expect PASS: `pnpm --filter web test src/panels/assistant/components/TabBar.test.tsx`

- [ ] Run the whole assistant suite, expect PASS: `pnpm --filter web test src/panels/assistant`

- [ ] Typecheck: `pnpm --filter web typecheck` (expect PASS)

- [ ] Commit:
```
git add apps/web/src/panels/assistant/AssistantContext.tsx apps/web/src/panels/assistant/components/TabBar.tsx apps/web/src/panels/assistant/components/TabContent.tsx apps/web/src/panels/assistant/components/TabBar.test.tsx
git commit -m "feat(web): wire the Agents tab into the Assistant panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9 — Final verification

Run the full web checks to confirm the feature is green end to end and nothing regressed.

**Files:** (none — verification only)

**Steps:**

- [ ] Full web test suite, expect PASS: `pnpm --filter web test`

- [ ] Typecheck, expect PASS: `pnpm --filter web typecheck`

- [ ] Build, expect PASS: `pnpm --filter web build`

- [ ] Server side (this plan added the `credentialStatus` action in Task 6b), expect PASS: `pnpm --filter @rigel/server test src/assistant.test.ts && pnpm --filter @rigel/server typecheck`

- [ ] Security check — confirm the server returns credential key NAMES only, never values: `grep -n "credentialStatus\|normalizeCredentialKeys\|credentialKeys" apps/server/src/assistant.ts` and eyeball that `credentialStatus` returns `JSON.stringify({ credentialKeys })` (key names from `Object.keys`) and never serializes `obj.data`'s values; confirm no `res.stdout` from the secret read is logged.

- [ ] Manual visual check against the Pencil frame `fo4qH` (not automated): launch the desktop app (`pnpm --filter desktop dev`) ONLY if asked — per the "no web dev server" feedback, verification is via tests/typecheck/build. Confirm the Agents tab shows the header, two role cards (effort segment on Claude only), the four credential rows with status chips, the limits grid, and the live-vs-restart footer note.

- [ ] Commit (if any verification fixups were needed):
```
git add -A
git commit -m "test(web): final verification for the Assistant multi-provider UI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done criteria

- A reusable `RolePicker` (provider + model + Claude-only effort) and `CredentialsManager` (per-provider key rows) + `LimitsForm`, all reusing `AgentGlyph` / `useAgentModels` / `useAgents`.
- An `AgentsTab` that pre-fills from the LIVE `assistant-config` (via `d.roles` / `d.limits` parsed in `useAssistant`) and saves via `setModels` (roles, live), `setLimits` (limits, live), and `setCredentials` (keys, behind a restart-confirm Dialog) — never re-installing.
- `InstallView` collects the two role selections + credentials and calls `install` with `worker`/`supervisor`/`credentials`; the default Claude-only flow is unchanged.
- The Agents tab is wired into `TabKey` / `TabBar` / `TabContent`.
- **Credential chips are accurate:** a new server `credentialStatus` action (Task 6b) reports which credential key NAMES exist across the credentials + legacy token Secrets (never values), and `useAssistant` surfaces it as `d.creds` (Task 6c) so a returning operator sees correctly which providers are configured; the chips refresh after a `setCredentials` save. Secret values never reach the client.
- `pnpm --filter web test`, `… typecheck`, `… build`, and `pnpm --filter @rigel/server test` / `typecheck` all pass.
