# Agent image update watcher (HELM-56) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface whether the in-cluster `rigel-assistant` agent is running a stale image in the Assistant status strip, and offer a guarded one-click update.

**Architecture:** CI stamps a monotonic semver (`0.<minor>.<run_number>`) on every continuous agent build and pins the deployment to it, so the running image is version-parseable. The web panel reads that image from the live cluster store, runs it through the existing `/api/updates` resolver, and renders an indicator in the StatusStrip that fires the existing `setImage` ConfirmSheet on click. No server route changes.

**Tech Stack:** GitHub Actions (agent-build.yml), React 19 + TanStack Query (apps/web), Vitest, `@rigel/catalog` update resolver, `withTag` + `setImage` ActionBlock.

**Spec:** `docs/superpowers/specs/2026-07-08-agent-image-update-watcher-design.md`. Pencil frame `f14leA` in `clankerlocal.pen`.

**Branch:** `feature/agent-image-update-watcher` (already checked out).

---

## File Structure

- `.github/workflows/agent-build.yml` — **modify.** Compute `0.<minor>.<run_number>`, add it to the pushed tags, pin the deploy to it.
- `packages/catalog/src/updates.test.ts` — **modify.** Characterization test proving the semver scheme resolves with the existing resolver.
- `apps/web/src/panels/assistant/useAssistant.ts` — **modify.** Add `pickAgentContainer()` helper; expose `agentImage` + `agentContainer` on `AssistantDerived`.
- `apps/web/src/panels/assistant/useAssistant.test.ts` — **create.** Unit-test `pickAgentContainer()`.
- `apps/web/src/panels/assistant/components/AgentUpdate.tsx` — **create.** Pure `AgentUpdateView` (three states) + smart `AgentUpdate` wrapper.
- `apps/web/src/panels/assistant/components/AgentUpdate.test.tsx` — **create.** Render tests for the three states.
- `apps/web/src/panels/assistant/components/StatusStrip.tsx` — **modify.** Render `<AgentUpdate />` in the installed-phase right cluster.

---

## Task 1: CI — continuous semver tag + pinned deploy

**Files:**
- Modify: `.github/workflows/agent-build.yml`

- [ ] **Step 1: Add a version-compute step and job output to the `build` job**

In `.github/workflows/agent-build.yml`, give the `build` job an output and a compute step. Add `outputs:` under `build:` (above `runs-on` is invalid — put it under the job, as shown) and insert the compute step right after `- uses: actions/checkout@v5`:

```yaml
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      version: ${{ steps.ver.outputs.version }}
    steps:
      - uses: actions/checkout@v5

      - name: Compute continuous version
        id: ver
        run: |
          MINOR=$(node -p "require('./agent/package.json').version.split('.')[1]")
          echo "version=0.${MINOR}.${{ github.run_number }}" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 2: Add the semver tag to the build-and-push tags**

Change the `tags:` block of the `Build and push` step from:

```yaml
          tags: |
            ${{ env.IMAGE }}:latest
            ${{ env.IMAGE }}:${{ github.sha }}
```

to:

```yaml
          tags: |
            ${{ env.IMAGE }}:latest
            ${{ env.IMAGE }}:${{ github.sha }}
            ${{ env.IMAGE }}:${{ steps.ver.outputs.version }}
```

- [ ] **Step 3: Pin the deploy to the semver tag**

In the `deploy` job's `Deploy the pinned image` step, change the `set image` line from:

```bash
          kubectl set image deployment/rigel-assistant agent=${{ env.IMAGE }}:${{ github.sha }} -n "$NS"
```

to:

```bash
          kubectl set image deployment/rigel-assistant agent=${{ env.IMAGE }}:${{ needs.build.outputs.version }} -n "$NS"
```

Leave the `rollout status` line unchanged. (`deploy` already has `needs: build`, so `needs.build.outputs.version` resolves.)

- [ ] **Step 4: Verify the YAML is well-formed**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/agent-build.yml'))" && echo OK`
Expected: `OK` (no parse error).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/agent-build.yml
git commit -m "ci(agent): pin continuous deploy to a monotonic 0.<minor>.<run_number> tag"
```

---

## Task 2: Resolver characterization test for the semver scheme

This proves the existing `@rigel/catalog` resolver handles `0.<minor>.<n>` with no code change — the load-bearing assumption of the whole feature. It's a guard test; it should pass immediately.

**Files:**
- Modify: `packages/catalog/src/updates.test.ts`

- [ ] **Step 1: Add the test**

`newestStableTag` and `statusFromTags` are already imported at the top of the file. Append this `describe` block at the end of `packages/catalog/src/updates.test.ts`:

```ts
describe("agent continuous semver scheme (HELM-56)", () => {
  // A realistic rigel-assistant GHCR tag set: continuous 0.1.<run> tags, the
  // release-images.yml minor/stable tags, plus moving + sha tags to be ignored.
  const tags = ["0.1.0", "0.1", "stable", "latest", "0.1.410", "0.1.412", "0.1.415", "3f2a1c9"];

  it("picks the newest continuous patch as latest", () => {
    expect(newestStableTag(tags)).toBe("0.1.415");
  });

  it("flags an update when the running patch is behind", () => {
    expect(statusFromTags("0.1.412", tags)).toEqual({
      kind: "updateAvailable",
      current: "0.1.412",
      latest: "0.1.415",
    });
  });

  it("reports up to date on the newest patch", () => {
    expect(statusFromTags("0.1.415", tags)).toEqual({
      kind: "upToDate",
      current: "0.1.415",
    });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @rigel/catalog test -- updates.test.ts`
Expected: PASS, including the new "agent continuous semver scheme (HELM-56)" block.

If `statusFromTags`/`newestStableTag` return a different shape than asserted, fix the assertions to match the real return values (do not change the resolver) and re-run.

- [ ] **Step 3: Commit**

```bash
git add packages/catalog/src/updates.test.ts
git commit -m "test(catalog): guard the agent 0.<minor>.<n> update-resolver scheme"
```

---

## Task 3: Expose the agent image on `AssistantDerived`

**Files:**
- Modify: `apps/web/src/panels/assistant/useAssistant.ts`
- Test: `apps/web/src/panels/assistant/useAssistant.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/assistant/useAssistant.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pickAgentContainer } from "./useAssistant";

describe("pickAgentContainer", () => {
  it("prefers the container named 'agent'", () => {
    expect(
      pickAgentContainer([
        { name: "sidecar", image: "busybox:1" },
        { name: "agent", image: "ghcr.io/x/rigel-assistant:0.1.415" },
      ]),
    ).toEqual({ image: "ghcr.io/x/rigel-assistant:0.1.415", container: "agent" });
  });

  it("falls back to the first container when none is named 'agent'", () => {
    expect(pickAgentContainer([{ name: "app", image: "ghcr.io/x/y:1" }])).toEqual({
      image: "ghcr.io/x/y:1",
      container: "app",
    });
  });

  it("returns null when there is no usable container", () => {
    expect(pickAgentContainer([])).toBeNull();
    expect(pickAgentContainer(undefined)).toBeNull();
    expect(pickAgentContainer([{ name: "agent" }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- useAssistant.test.ts`
Expected: FAIL — `pickAgentContainer` is not exported.

- [ ] **Step 3: Add the container-image fields to `DeploymentLike`**

In `apps/web/src/panels/assistant/useAssistant.ts`, extend the local `DeploymentLike` interface (currently `spec?: { replicas?: number }`) so the pod template's containers are readable:

```ts
interface DeploymentLike {
  metadata: Meta;
  spec?: {
    replicas?: number;
    template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } };
  };
  status?: { replicas?: number; readyReplicas?: number };
}
```

- [ ] **Step 4: Add the `pickAgentContainer` helper**

Add this exported helper near the other exported parse helpers at the bottom of `useAssistant.ts`:

```ts
/** The agent container's image + name from a Deployment's pod template. Prefers
 *  the container named "agent" (what CI's `set image` targets); else the first
 *  container. null when there is no container with both a name and an image. */
export function pickAgentContainer(
  containers: Array<{ name?: string; image?: string }> | undefined,
): { image: string; container: string } | null {
  const list = containers ?? [];
  const picked = list.find((c) => c.name === "agent") ?? list[0];
  if (!picked?.image || !picked?.name) return null;
  return { image: picked.image, container: picked.name };
}
```

- [ ] **Step 5: Add `agentImage` + `agentContainer` to the `AssistantDerived` interface**

In the `AssistantDerived` interface, add these two fields (near `installedNamespace`):

```ts
  /** The running agent container's image ref (e.g. ".../rigel-assistant:0.1.412"), or null. */
  agentImage: string | null;
  /** The agent container's name (for the setImage update action), or null. */
  agentContainer: string | null;
```

- [ ] **Step 6: Populate them in the derived memo**

Inside the returned `useMemo` object (after `installedNamespace` is computed), derive and return the fields. Add just before the `return {` that builds the object:

```ts
    const agentRef = pickAgentContainer(agentDeployment?.spec?.template?.spec?.containers);
```

and add to the returned object literal:

```ts
      agentImage: agentRef?.image ?? null,
      agentContainer: agentRef?.container ?? null,
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter web test -- useAssistant.test.ts`
Expected: PASS (all three `pickAgentContainer` cases).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/panels/assistant/useAssistant.ts apps/web/src/panels/assistant/useAssistant.test.ts
git commit -m "feat(assistant): expose the running agent image on AssistantDerived"
```

---

## Task 4: `AgentUpdateView` — the pure indicator component

**Files:**
- Create: `apps/web/src/panels/assistant/components/AgentUpdate.tsx`
- Test: `apps/web/src/panels/assistant/components/AgentUpdate.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/assistant/components/AgentUpdate.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentUpdateView } from "./AgentUpdate";
import type { UpdateResult } from "@/lib/api";

const base: UpdateResult = {
  image: "ghcr.io/x/rigel-assistant:0.1.412",
  currentTag: "0.1.412",
  latest: null,
  updateAvailable: false,
  kind: "none",
};

describe("AgentUpdateView", () => {
  it("renders nothing while the result is undefined", () => {
    const { container } = render(<AgentUpdateView result={undefined} onUpdate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows current -> latest and updates on click", () => {
    const onUpdate = vi.fn();
    render(
      <AgentUpdateView
        result={{ ...base, latest: "0.1.415", updateAvailable: true, kind: "version" }}
        onUpdate={onUpdate}
      />,
    );
    expect(screen.getByText("0.1.412")).toBeInTheDocument();
    expect(screen.getByText("0.1.415")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /update/i }));
    expect(onUpdate).toHaveBeenCalledWith("0.1.415");
  });

  it("shows an up-to-date state with no button", () => {
    render(<AgentUpdateView result={{ ...base, currentTag: "0.1.415" }} onUpdate={vi.fn()} />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows an unreachable state with the reason as a tooltip", () => {
    render(
      <AgentUpdateView
        result={{ ...base, kind: "unknown", reason: "registry returned HTTP 503" }}
        onUpdate={vi.fn()}
      />,
    );
    const el = screen.getByText(/couldn't check/i);
    expect(el).toBeInTheDocument();
    expect(el.closest("[title]")?.getAttribute("title")).toBe("registry returned HTTP 503");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- AgentUpdate.test.tsx`
Expected: FAIL — `./AgentUpdate` has no `AgentUpdateView` export.

- [ ] **Step 3: Implement `AgentUpdateView`**

Create `apps/web/src/panels/assistant/components/AgentUpdate.tsx` with the pure view (tokens/classes mirror StatusStrip + Pencil frame `f14leA`):

```tsx
import { CircleArrowUp, Check, CloudOff, Info } from "lucide-react";
import type { UpdateResult } from "@/lib/api";

function Divider() {
  return <span aria-hidden className="h-[22px] w-px shrink-0 bg-[var(--border-strong)]" />;
}

/** Pure render of the agent update indicator. Returns null when there is nothing
 *  to show (no result yet). Trailing divider separates it from the token group. */
export function AgentUpdateView({
  result,
  onUpdate,
}: {
  result: UpdateResult | undefined | null;
  onUpdate: (latest: string) => void;
}) {
  if (!result) return null;

  if (result.updateAvailable && result.latest) {
    const latest = result.latest;
    return (
      <>
        <span className="flex items-center gap-2 whitespace-nowrap rounded-md bg-[var(--accent-dim)] px-2.5 py-1">
          <CircleArrowUp className="size-3.5 shrink-0 text-[var(--accent-primary)]" />
          <span className="font-mono text-xs text-[var(--fg-tertiary)]">{result.currentTag}</span>
          <span aria-hidden className="font-mono text-xs text-[var(--fg-tertiary)]">→</span>
          <span className="font-mono text-xs font-semibold text-[var(--accent-primary)]">{latest}</span>
        </span>
        <button
          type="button"
          onClick={() => onUpdate(latest)}
          className="rounded-md bg-[var(--accent-primary)] px-2.5 py-1 text-xs font-semibold text-[var(--fg-inverse)]"
        >
          Update
        </button>
        <Divider />
      </>
    );
  }

  if (result.kind === "unknown") {
    return (
      <>
        <span
          title={result.reason}
          className="flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--fg-tertiary)]"
        >
          <CloudOff className="size-3.5 shrink-0" />
          Couldn't check for updates
          <Info className="size-3 shrink-0" />
        </span>
        <Divider />
      </>
    );
  }

  return (
    <>
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--fg-tertiary)]">
        <Check className="size-3.5 shrink-0 text-[var(--status-running)]" />
        Up to date
        {result.currentTag && <span className="font-mono">{result.currentTag}</span>}
      </span>
      <Divider />
    </>
  );
}
```

Note on tokens (verified in `apps/web/src/index.css`): `--accent-primary` (#38bdf8), `--accent-dim` (rgba(56,189,248,0.15)), `--fg-inverse` (#0a0a0a), `--fg-tertiary`, `--border-strong`, `--surface-elevated`, and `--status-running` all already exist. No `index.css` change is needed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter web test -- AgentUpdate.test.tsx`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/components/AgentUpdate.tsx apps/web/src/panels/assistant/components/AgentUpdate.test.tsx
git commit -m "feat(assistant): AgentUpdateView indicator (available / up-to-date / unreachable)"
```

---

## Task 5: `AgentUpdate` smart wrapper (wires data + the update action)

**Files:**
- Modify: `apps/web/src/panels/assistant/components/AgentUpdate.tsx`

- [ ] **Step 1: Add the smart wrapper**

Append to `apps/web/src/panels/assistant/components/AgentUpdate.tsx`. It reads the agent image from context, runs the existing updates query, and fires the existing ConfirmSheet via `runSuggestion`:

```tsx
import { useUpdates } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { withTag } from "@/panels/catalog/updateTargets";
```

```tsx
/** Reads the running agent image, checks it against the registry, and renders the
 *  indicator. The Update button opens the standard setImage ConfirmSheet. */
export function AgentUpdate() {
  const { d, runSuggestion } = useAssistantCtx();
  const image = d.agentImage;
  const updates = useUpdates(image ? [image] : []);
  const result = updates.data?.results.find((r) => r.image === image);

  if (!image) return null;

  const onUpdate = (latest: string) => {
    runSuggestion({
      kind: "setImage",
      label: `Update agent to ${latest}`,
      name: "rigel-assistant",
      namespace: d.installedNamespace ?? d.stateNamespace,
      resourceKind: "deployment",
      container: d.agentContainer ?? "agent",
      image: withTag(image, latest),
    });
  };

  return <AgentUpdateView result={result} onUpdate={onUpdate} />;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS (no type errors). `runSuggestion` accepts an `ActionBlock`; `kind: "setImage"` with `name`/`namespace`/`resourceKind`/`container`/`image` all match the `ActionBlock` interface.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/assistant/components/AgentUpdate.tsx
git commit -m "feat(assistant): wire AgentUpdate to /api/updates + the setImage ConfirmSheet"
```

---

## Task 6: Render the indicator in the StatusStrip

**Files:**
- Modify: `apps/web/src/panels/assistant/components/StatusStrip.tsx`

- [ ] **Step 1: Import `AgentUpdate`**

Add to the imports at the top of `StatusStrip.tsx`:

```tsx
import { AgentUpdate } from "./AgentUpdate";
```

- [ ] **Step 2: Render it in the installed-phase right cluster**

In the installed-phase `return` (the final `return (<Strip>…)`), replace the trailing token block:

```tsx
      {/* Token — ready.secrets */}
      <TokenGroup>
        {ready.secrets && d.tokenExpiry ? (
          <span className={`font-mono text-sm font-semibold ${tokenColorClass(d.tokenExpiry.level)}`}>
            {tokenLabel(d.tokenExpiry)}
          </span>
        ) : (
          skelVal
        )}
      </TokenGroup>
```

with a right cluster that puts the update indicator left of the token group:

```tsx
      <div className="flex flex-wrap items-center gap-3">
        <AgentUpdate />
        <TokenGroup>
          {ready.secrets && d.tokenExpiry ? (
            <span className={`font-mono text-sm font-semibold ${tokenColorClass(d.tokenExpiry.level)}`}>
              {tokenLabel(d.tokenExpiry)}
            </span>
          ) : (
            skelVal
          )}
        </TokenGroup>
      </div>
```

Leave the `loading` and `install` phase returns unchanged — the indicator only shows once the agent is installed. `AgentUpdate` renders null (no divider) until the updates query resolves, so the strip shape is stable.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/panels/assistant/components/StatusStrip.tsx
git commit -m "feat(assistant): show the agent update indicator in the StatusStrip"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the web test suite**

Run: `pnpm --filter web test`
Expected: PASS (existing suite + `useAssistant.test.ts` + `AgentUpdate.test.tsx`).

- [ ] **Step 2: Run the catalog test suite**

Run: `pnpm --filter @rigel/catalog test`
Expected: PASS (existing suite + the HELM-56 scheme block).

- [ ] **Step 3: Typecheck + build the web app**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both PASS.

- [ ] **Step 4: Verify the change in the running app (per the `verify` skill)**

The indicator only renders when the `rigel-assistant` agent is installed. If a dev cluster with the agent is available, launch the desktop app (`pnpm --filter desktop dev`), open the Assistant panel, and confirm the StatusStrip shows the up-to-date state (agent current) — and, if you can point at a cluster running an older tag, the "update available" pill + Update button, and that clicking opens the ConfirmSheet previewing `kubectl set image deployment/rigel-assistant agent=…:<latest> -n <ns>`. Do NOT execute the applied command against a real cluster just to verify wiring; the ConfirmSheet preview is the checkpoint. If no such cluster is available, note that the runtime check was skipped and rely on the component tests.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(helm-56): verification fixups" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- CI reads the running tag / pins immutable version → Task 1. ✓
- Compare against latest via existing resolver + GHCR logic → Tasks 2–5 (reuse `/api/updates`). ✓
- "Update available" indicator showing current vs latest → Tasks 4 + 6. ✓
- One-click update via `setImage` + ConfirmSheet → Task 5 (`runSuggestion` → hosted ConfirmSheet → `/api/action`). ✓
- Handle "can't reach registry" + "already latest" cleanly → Task 4 (unknown + up-to-date states). ✓
- Release-version coherence (agent minor tracks package.json) → Task 1 uses `agent/package.json` minor; the `cut-release` skill bumps it in lockstep. ✓
- Tests → Tasks 2, 3, 4. ✓

**Type consistency:** `pickAgentContainer` returns `{ image, container }` (Task 3) consumed in Task 5 via `d.agentImage` / `d.agentContainer`. `AgentUpdateView` props `{ result: UpdateResult | undefined | null; onUpdate: (latest: string) => void }` are identical in Tasks 4 and 5. `runSuggestion(a: ActionBlock)` and the `ActionBlock` fields (`kind`,`name`,`namespace`,`resourceKind`,`container`,`image`,`label`) match `apps/web/src/lib/api.ts`. `useUpdates(images: string[])` returns `{ data?: { results: UpdateResult[] } }`.

**Placeholder scan:** none — every code step shows complete code. The only conditional is the CSS-variable name check in Task 4 Step 3, which names the exact fallback values to add.
