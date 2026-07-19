# Agent Activity Actor Stamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp every in-cluster agent activity entry with the actor that initiated it (🤖 Autonomous / 👤 Approved by you / 🔀 Opened a PR) and render that stamp in the three Recent Activity surfaces.

**Architecture:** The agent already writes a durable audit ledger (`AuditEntry`) to the `assistant-state` ConfigMap, and the app already renders it via the shared `AssistantAuditEntry` type. We add one optional field, `actor`, to both types; set it at the code paths that create entries (autonomous remediation, chat-approved execution, autofix-PR pipeline); pass it through decode (a raw cast, so it flows automatically); and render a small badge. Entries written before this ships have no `actor` and render no badge.

**Tech Stack:** TypeScript monorepo. Agent: Node + vitest (`rigel-assistant-agent`). Shared types/decode: `@rigel/k8s` + vitest. Frontend: React 19 + Tailwind v4 + Font Awesome Pro, package `web`, vitest.

**Actor taxonomy (the `actor` field values):**
- `"autonomous"` — the agent's autonomous remediation loop decided and acted (everything through `record()` + the queue auto-clear).
- `"chat"` — the agent executed because the user approved/asked in chat (`executeChatAction`).
- `"pr"` — the autofix-PR pipeline (`repoFixDispatch` entries + the `reconcileFixJobs` terminal entry).

---

## File Structure

- `packages/k8s/src/assistant.ts` — add `actor?` to `AssistantAuditEntry` (the shared decoded type). Decode already casts the audit array wholesale, so `actor` passes through with no logic change.
- `agent/src/state.ts` — add `AuditActor` type + `actor?` to `AuditEntry`.
- `agent/src/index.ts` — stamp `autonomous` centrally in `record()`; stamp the queue auto-clear entry; stamp `chat` in `executeChatAction`.
- `agent/src/repoFixDispatch.ts` — stamp `pr` on the five autofix-dispatch audit entries.
- `agent/src/reconcileFixJobs.ts` — stamp `pr` on the terminal audit entry (both branches).
- `apps/web/src/panels/assistant/display.ts` — add pure `actorLabel()` helper.
- `apps/web/src/panels/assistant/components/ActorBadge.tsx` — new thin badge component (icon + label).
- `apps/web/src/panels/assistant/ActivityCard.tsx`, `AuditRow.tsx`, `components/RecentActivityCard.tsx` — render `<ActorBadge>`.

---

### Task 1: `actor` on the shared decoded type (`@rigel/k8s`)

**Files:**
- Modify: `packages/k8s/src/assistant.ts:889-901` (`AssistantAuditEntry`)
- Test: `packages/k8s/src/assistant.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/k8s/src/assistant.test.ts` (mirrors the existing `decodeClusterState parses audit/queue/report/status` test at line 343):

```ts
test("decodeClusterState passes the audit actor field through", () => {
  const raw = JSON.stringify({
    audit: [
      { at: "t1", fingerprint: "f", incident: "i", tier: "low", outcome: "success", detail: "", actor: "autonomous" },
      { at: "t2", fingerprint: "f", incident: "i", tier: "medium", outcome: "success", detail: "", actor: "pr" },
      { at: "t3", fingerprint: "f", incident: "i", tier: "low", outcome: "success", detail: "" },
    ],
  });
  const s = decodeClusterState(raw)!;
  expect(s.audit[0]!.actor).toBe("autonomous");
  expect(s.audit[1]!.actor).toBe("pr");
  expect(s.audit[2]!.actor).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s exec vitest run src/assistant.test.ts`
Expected: FAIL — TypeScript error "Property 'actor' does not exist on type 'AssistantAuditEntry'".

- [ ] **Step 3: Add the field**

In `packages/k8s/src/assistant.ts`, change `AssistantAuditEntry` (line 889-901) to add `actor` after `analysis`:

```ts
export interface AssistantAuditEntry {
  at: string;
  fingerprint: string;
  incident: string;
  proposal?: string;
  command?: string;
  tier: string;
  verdict?: string;
  outcome: string;
  detail: string;
  backupRef?: string;
  analysis?: string;
  /** Who initiated this action: the autonomous loop, a chat approval, or the
   * autofix-PR pipeline. Absent on entries written before actor stamping shipped. */
  actor?: string;
}
```

No change to `decodeClusterState` — `o.audit as AssistantAuditEntry[]` (line 1000) already carries `actor` through at runtime.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s exec vitest run src/assistant.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/assistant.ts packages/k8s/src/assistant.test.ts
git commit -m "feat(k8s): add actor field to AssistantAuditEntry (HELM-96)"
```

---

### Task 2: `actor` type + autonomous stamp (agent)

**Files:**
- Modify: `agent/src/state.ts:13-31` (add `AuditActor`, extend `AuditEntry`)
- Modify: `agent/src/index.ts:992-1005` (`record()` stamps `autonomous`), `agent/src/index.ts:342-349` (queue auto-clear stamps `autonomous`)
- Test: `agent/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

In `agent/src/index.test.ts`, extend the existing autonomous-success assertion. Find the test around line 361-369 whose assertion is `expect(state!.audit[0]).toMatchObject({ proposal: "Restart memos", outcome: "success" });` and add `actor`:

```ts
      expect(state!.audit[0]).toMatchObject({ proposal: "Restart memos", outcome: "success", actor: "autonomous" });
```

Also extend the triage-skipped assertion around line 331:

```ts
    expect(state!.audit[0]).toMatchObject({ incident: expect.stringContaining("logger-7d9f-abc"), outcome: "skipped", actor: "autonomous" });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter rigel-assistant-agent exec vitest run src/index.test.ts`
Expected: FAIL — `actor` is `undefined`, not `"autonomous"` (plus a TS error on the unknown property until Step 3 lands the type).

- [ ] **Step 3: Add the `AuditActor` type and field**

In `agent/src/state.ts`, after the existing type aliases (line 15) add:

```ts
export type AuditActor = "autonomous" | "chat" | "pr";
```

Then in the `AuditEntry` interface (line 17-31) add `actor` after `analysis`:

```ts
  analysis?: string;
  /** Who initiated this action. Absent on entries written before actor stamping. */
  actor?: AuditActor;
```

- [ ] **Step 4: Stamp `autonomous` in `record()`**

In `agent/src/index.ts`, change the `appendAudit` call inside `record()` (line 993) so every entry that flows through the autonomous funnel is stamped, without overriding an explicit actor:

```ts
function record(state: AssistantState, cfg: Config, entry: AuditEntry): AssistantState {
  let next = appendAudit(state, { ...entry, actor: entry.actor ?? "autonomous" }, cfg.auditMaxEntries);
```

- [ ] **Step 5: Stamp the queue auto-clear entry**

In `agent/src/index.ts`, the queue-reconcile audit append (line 342-349) does not go through `record()`. Add `actor: "autonomous"` to that entry literal:

```ts
          state = appendAudit(
            state,
            {
              at: ts, fingerprint: c.item.fingerprint ?? "", incident: c.item.incident,
              proposal: c.item.suggestion, tier: "low", outcome: "skipped", detail: c.reason,
              actor: "autonomous",
            },
            cfg.auditMaxEntries,
          );
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter rigel-assistant-agent exec vitest run src/index.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/src/state.ts agent/src/index.ts agent/src/index.test.ts
git commit -m "feat(agent): stamp autonomous actor on agent audit entries (HELM-96)"
```

---

### Task 3: `pr` stamp on the autofix pipeline (agent)

**Files:**
- Modify: `agent/src/repoFixDispatch.ts` (five `appendAudit` entries: lines 81, 91, 111, 139, 149)
- Modify: `agent/src/reconcileFixJobs.ts:159-168` (terminal entry, both branches)
- Test: `agent/src/repoFixDispatch.test.ts`, `agent/src/reconcileFixJobs.test.ts`, `agent/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

In `agent/src/repoFixDispatch.test.ts`, extend the happy-path assertion (line 56):

```ts
    expect(state.audit[0]).toMatchObject({ outcome: "queued", tier: "medium", proposal: ACTION.title, actor: "pr" });
```

In `agent/src/reconcileFixJobs.test.ts`, extend the terminal-entry assertion (line 65):

```ts
    expect(r.state.audit[0]).toMatchObject({ outcome: "success", proposal: TITLE, fingerprint: FP, actor: "pr" });
```

In `agent/src/index.test.ts`, extend the openFixPR-pending assertion (line 276):

```ts
    expect(state!.audit[0]).toMatchObject({ proposal: OPEN_FIX_PR.title, outcome: "queued", tier: "medium", actor: "pr" });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter rigel-assistant-agent exec vitest run src/repoFixDispatch.test.ts src/reconcileFixJobs.test.ts src/index.test.ts`
Expected: FAIL — `actor` is `undefined`, not `"pr"`.

- [ ] **Step 3: Stamp `pr` on the five `repoFixDispatch` entries**

In `agent/src/repoFixDispatch.ts`, add `actor: "pr",` to each of the five audit entry literals. The lines and their existing fields:

At line 81-86 (`!d.inScope`):
```ts
      state: appendAudit(state, {
        at: d.at, fingerprint: d.fingerprint, incident: d.incident, proposal: d.action.label,
        tier: "medium", outcome: "skipped",
        detail: "openFixPR proposed, but autofix is disabled or this workload is outside the autofix scope",
        analysis: truncate(d.analysis), actor: "pr",
      }, d.auditMaxEntries),
```

At line 91-96 (`!d.repo`):
```ts
      state: appendAudit(state, {
        at: d.at, fingerprint: d.fingerprint, incident: d.incident, proposal: d.action.label,
        tier: "medium", outcome: "skipped",
        detail: "openFixPR proposed, but the workload has no GitOps source (not autofix-eligible)",
        analysis: truncate(d.analysis), actor: "pr",
      }, d.auditMaxEntries),
```

At line 111-116 (`!d.image`):
```ts
        state: appendAudit(state, {
          at: d.at, fingerprint: d.fingerprint, incident: d.incident, proposal: suggestion,
          tier: "medium", outcome: "failure",
          detail: "openFixPR approved, but the fix-runner image is not configured (RIGEL_FIX_RUNNER_IMAGE): cannot open the PR",
          analysis: truncate(d.analysis), actor: "pr",
        }, d.auditMaxEntries),
```

At line 139-144 (catch / Job creation failed):
```ts
      state: appendAudit(state, {
        at: d.at, fingerprint: d.fingerprint, incident: d.incident, proposal: suggestion,
        tier: "medium", outcome: "failure",
        detail: truncate(`openFixPR approved, but the fix Job could not be created (fail-safe): ${String(err)}`),
        analysis: truncate(d.analysis), actor: "pr",
      }, d.auditMaxEntries),
```

At line 149-152 (pending queued):
```ts
  let next = appendAudit(state, {
    at: d.at, fingerprint: d.fingerprint, incident: d.incident, proposal: suggestion,
    tier: "medium", outcome: "queued", detail, analysis: truncate(d.analysis), actor: "pr",
  }, d.auditMaxEntries);
```

- [ ] **Step 4: Stamp `pr` on the `reconcileFixJobs` terminal entry**

In `agent/src/reconcileFixJobs.ts`, add `actor: "pr",` to both branches of the `terminal` entry (line 159-168):

```ts
      const terminal: AuditEntry = opened
        ? {
            at: ctx.at, fingerprint: meta.fingerprint, incident: meta.incident, proposal: title,
            tier: "medium", outcome: "success", detail: `Rigel opened a fix PR: ${result.prUrl}`,
            actor: "pr",
          }
        : {
            at: ctx.at, fingerprint: meta.fingerprint, incident: meta.incident, proposal: title,
            tier: "medium", outcome: "failure",
            detail: `fix PR could not be opened: ${result.message ?? "(no detail reported)"}`,
            actor: "pr",
          };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter rigel-assistant-agent exec vitest run src/repoFixDispatch.test.ts src/reconcileFixJobs.test.ts src/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/src/repoFixDispatch.ts agent/src/reconcileFixJobs.ts agent/src/repoFixDispatch.test.ts agent/src/reconcileFixJobs.test.ts agent/src/index.test.ts
git commit -m "feat(agent): stamp pr actor on autofix-pipeline audit entries (HELM-96)"
```

---

### Task 4: `chat` stamp on chat-approved execution (agent)

**Files:**
- Modify: `agent/src/index.ts:905-912` (the inline `audit` callback in `executeChatAction`)

**Note:** `executeChatAction` is private glue reached only through inbound chat handlers, and existing tests (`chatHandler.test.ts`, `executeActionGuarded.test.ts`) mock the `audit`/`execute` callbacks, so there is no unit seam for this specific literal. The change is guarded by the `AuditActor` union (a typo fails compilation) and verified by typecheck + the full build in Task 7. This matches the repo's existing pattern of not unit-testing `index.ts` inline callbacks.

- [ ] **Step 1: Stamp `chat`**

In `agent/src/index.ts`, add `actor: "chat",` to the audit entry appended inside `executeChatAction` (line 907-912):

```ts
      s = appendAudit(s, {
        at: new Date().toISOString(), fingerprint: fp, incident, proposal: action.label,
        command, tier: tier === RiskTier.Medium ? "medium" : "low",
        verdict: "approved", outcome: success ? "success" : "failure",
        detail: truncate(`${matched ? "flagged fix approved" : "confirmed"} via chat — ${output}`), backupRef,
        actor: "chat",
      }, cfg.auditMaxEntries);
```

- [ ] **Step 2: Typecheck the agent**

Run: `pnpm --filter rigel-assistant-agent build`
Expected: PASS (tsc compiles; `"chat"` is a valid `AuditActor`).

- [ ] **Step 3: Commit**

```bash
git add agent/src/index.ts
git commit -m "feat(agent): stamp chat actor on chat-approved audit entries (HELM-96)"
```

---

### Task 5: `actorLabel()` pure helper (web)

**Files:**
- Modify: `apps/web/src/panels/assistant/display.ts`
- Test: `apps/web/src/panels/assistant/display.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/panels/assistant/display.test.ts`:

```ts
import { actorLabel } from "./display";

describe("actorLabel", () => {
  it("maps each known actor to its label", () => {
    expect(actorLabel("autonomous")).toBe("Autonomous");
    expect(actorLabel("chat")).toBe("Approved by you");
    expect(actorLabel("pr")).toBe("Opened a PR");
  });
  it("returns null for undefined or unknown actors", () => {
    expect(actorLabel(undefined)).toBeNull();
    expect(actorLabel("something-else")).toBeNull();
  });
});
```

If `display.test.ts` does not already import `describe`/`it`/`expect`, match its existing import style (add `actorLabel` to the existing `./display` import rather than a second import line).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run src/panels/assistant/display.test.ts`
Expected: FAIL — `actorLabel is not a function` / no export.

- [ ] **Step 3: Add the helper**

Append to `apps/web/src/panels/assistant/display.ts`:

```ts
/** Human label for an audit entry's actor, or null when absent/unknown (legacy
 * entries and unrecognised values render no badge). */
export function actorLabel(actor: string | undefined): string | null {
  switch (actor) {
    case "autonomous":
      return "Autonomous";
    case "chat":
      return "Approved by you";
    case "pr":
      return "Opened a PR";
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run src/panels/assistant/display.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/display.ts apps/web/src/panels/assistant/display.test.ts
git commit -m "feat(web): actorLabel helper for audit actor stamps (HELM-96)"
```

---

### Task 6: `ActorBadge` component + wire into the three surfaces (web)

**Files:**
- Create: `apps/web/src/panels/assistant/components/ActorBadge.tsx`
- Modify: `apps/web/src/panels/assistant/ActivityCard.tsx`, `apps/web/src/panels/assistant/AuditRow.tsx`, `apps/web/src/panels/assistant/components/RecentActivityCard.tsx`

- [ ] **Step 1: Create the badge component**

Create `apps/web/src/panels/assistant/components/ActorBadge.tsx`. The styling matches the existing tier pill in `ActivityCard` (`bg-white/[0.05] px-2 py-0.5 font-mono text-3xs uppercase text-[var(--fg-tertiary)]`). It uses the pure `actorLabel` for the text and returns `null` when there's no label.

```tsx
// ActorBadge — a small provenance pill on an audit entry: who initiated the
// action (the autonomous loop, a chat approval, or the autofix-PR pipeline).
// Renders nothing for legacy/unknown actors.

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faRobot, faUser, faCodePullRequest } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { cn } from "@/lib/utils";
import { actorLabel } from "../display";

const ACTOR_ICON: Record<string, IconDefinition> = {
  autonomous: faRobot,
  chat: faUser,
  pr: faCodePullRequest,
};

export function ActorBadge({ actor, className }: { actor?: string; className?: string }) {
  const label = actorLabel(actor);
  const icon = actor ? ACTOR_ICON[actor] : undefined;
  if (!label || !icon) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded bg-white/[0.05] px-2 py-0.5 font-mono text-3xs tracking-[0.03em] text-[var(--fg-tertiary)] uppercase",
        className,
      )}
    >
      <FontAwesomeIcon icon={icon} className="size-2.5" />
      {label}
    </span>
  );
}
```

- [ ] **Step 2: Wire into `ActivityCard.tsx`**

In `apps/web/src/panels/assistant/ActivityCard.tsx`, add the import near the other local imports (after line 24):

```tsx
import { ActorBadge } from "./components/ActorBadge";
```

Then render the badge in the header's right-hand cluster, immediately before the tier pill (line 83). The block becomes:

```tsx
        <div className="flex shrink-0 items-center gap-3">
          <ActorBadge actor={e.actor} />
          {e.tier && (
```

- [ ] **Step 3: Wire into `AuditRow.tsx`**

In `apps/web/src/panels/assistant/AuditRow.tsx`, add the import after line 8:

```tsx
import { ActorBadge } from "./components/ActorBadge";
```

Then render it in the right-hand meta span, before the tier span (line 45). The block becomes:

```tsx
        <span className="ml-auto flex items-center gap-2">
          {canExpand &&
            (isOpen ? (
              <FontAwesomeIcon icon={faChevronDown} className="size-3" />
            ) : (
              <FontAwesomeIcon icon={faChevronRight} className="size-3" />
            ))}
          <ActorBadge actor={e.actor} />
          <span className="font-mono text-3xs uppercase text-muted-foreground">{e.tier}</span>
```

- [ ] **Step 4: Wire into `RecentActivityCard.tsx`**

In `apps/web/src/panels/assistant/components/RecentActivityCard.tsx`, add the import after line 30:

```tsx
import { ActorBadge } from "./ActorBadge";
```

Then render it in the header, immediately before the tier pill (line 152). Insert:

```tsx
        <ActorBadge actor={e.actor} />
        {e.tier && (
```

- [ ] **Step 5: Typecheck + build the web app**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: PASS (confirms the `@awesome.me` icon names `faRobot`, `faUser`, `faCodePullRequest` resolve and `e.actor` is a valid field).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/assistant/components/ActorBadge.tsx apps/web/src/panels/assistant/ActivityCard.tsx apps/web/src/panels/assistant/AuditRow.tsx apps/web/src/panels/assistant/components/RecentActivityCard.tsx
git commit -m "feat(web): render actor badge on agent activity surfaces (HELM-96)"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run all three test suites**

Run:
```bash
pnpm --filter @rigel/k8s test && pnpm --filter rigel-assistant-agent test && pnpm --filter web test
```
Expected: all PASS.

- [ ] **Step 2: Typecheck + build the packages that changed**

Run:
```bash
pnpm --filter @rigel/k8s build && pnpm --filter rigel-assistant-agent build && pnpm --filter web typecheck
```
Expected: all PASS.

- [ ] **Step 3: Mark the draft PR ready**

Run:
```bash
gh pr ready
```
Expected: PR #68 flips from draft to ready for review.

---

## Notes / decisions

- **Legacy entries** (no `actor`) render no badge — `actorLabel` returns `null` and `ActorBadge` returns `null`. No default actor is invented.
- **Decode needs no logic change** — `decodeClusterState` casts the audit array wholesale (`o.audit as AssistantAuditEntry[]`), so `actor` passes through at runtime; only the type gains the field. This follows the existing loose treatment of `tier`/`verdict`/`outcome`.
- **"Opened a PR" label** stamps every autofix-PR-pipeline entry (`pr`), including the uncommon skipped/failed dispatch cases; the outcome status icon already conveys success/failure independently. If a more provenance-neutral word is wanted later (e.g. "Autofix"), it's a one-line change in `actorLabel`.
- **Icon names to verify at build**: `faRobot`, `faUser`, `faCodePullRequest` from `@awesome.me/kit-6050953220/icons/classic/solid`. Task 6 Step 5 catches any that don't resolve.
