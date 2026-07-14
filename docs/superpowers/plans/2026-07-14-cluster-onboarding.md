# First-run cluster onboarding wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** When a signed-in user has no cluster (no kubeconfig contexts), show a welcoming first-run screen that routes them into an existing way to get a cluster — instead of the empty app shell. Ticket HELM-94. Design: Pencil frame "Cluster Onboarding (design)".

**Architecture:** A new full-screen `ClusterOnboarding` component (matches the design) whose three cards open the **existing, tested** flows — `CreateClusterModal` (local kind/k3d, has Docker/tool detection + WS progress), `ConnectClusterModal`/`ConnectWizard` (cloud), and the import-kubeconfig flow. Gated in `AppContent` on `useContexts()` being empty; auto-dismisses when a context appears (the create/connect/import flows invalidate the `["contexts"]` query). "Skip for now" is a soft escape.

**Scope:** assembly, not new cluster machinery. No backend changes. Local-first hero.

**Branch:** `feature/cluster-onboarding` off master.

---

## Task 1: `ClusterOnboarding` component

**Files:** Create `apps/web/src/shell/onboarding/ClusterOnboarding.tsx`; Test `apps/web/src/shell/onboarding/ClusterOnboarding.test.tsx`.

READ FIRST: `apps/web/src/shell/CreateClusterModal.tsx`, `apps/web/src/shell/ConnectClusterModal.tsx`, `apps/web/src/shell/ImportKubeconfigPanel.tsx`, `apps/web/src/shell/AddClusterChooser.tsx`, and `apps/web/src/shell/OnboardingWizard.tsx` (for the full-screen overlay chrome pattern) — to learn the exact props each modal takes (open/onOpenChange etc.) and reuse them.

**Behavior:**
- Props: `{ onSkip: () => void }`.
- Full-screen screen matching the Pencil design: `--surface-sunken` background, centered ~560px column: RIGEL brand, heading "Connect a cluster to get started", sub "Rigel works with any Kubernetes cluster. Pick how you'd like to connect — you can add more anytime.", then three option cards, then footer ("New to Kubernetes? Learn the basics" + "Skip for now").
- Local state `open: "create" | "connect" | "import" | null`.
- **Create a local cluster** (hero, accent border/tint, "RECOMMENDED" pill, `box` icon) → opens `CreateClusterModal`.
- **Connect a cloud cluster** (`cloud` icon) → opens `ConnectClusterModal`.
- **Import a kubeconfig** (`file-text` icon) → open the import flow. If `ConnectClusterModal` already contains the import tile, either open it there or wrap `ImportKubeconfigPanel` in a shadcn `Dialog` — pick whichever the actual component APIs make cleanest; reuse `ImportKubeconfigPanel`, don't reimplement.
- Render the chosen modal with `open`/`onOpenChange` bound to the local state (they render over the screen). When a modal completes and a context is created, the parent gate (Task 2) unmounts this whole screen — this component doesn't need to detect success itself.
- **"Learn the basics"** → an `<a href="https://kubernetes.io/docs/tutorials/kubernetes-basics/">` (the app's `setWindowOpenHandler` routes https links to the system browser) — or an onClick that opens it; match how other external links in the app are done.
- **"Skip for now"** → `onSkip()`.
- Tokens/Tailwind only (no raw-hex `style`), mirror the account-card class conventions.

- [ ] **Step 1 (test):** RTL, jsdom. Mock the three modal components (`vi.mock`) to simple stubs that expose whether they're open. Assert: renders the heading + the three card titles ("Create a local cluster", "Connect a cloud cluster", "Import a kubeconfig"); clicking a card opens the corresponding modal (stub receives `open`); clicking "Skip for now" calls `onSkip`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement per the design + behavior above.
- [ ] **Step 4:** `pnpm --filter web test ClusterOnboarding` → pass; `pnpm --filter web typecheck` → clean.
- [ ] **Step 5:** Commit `feat(web): first-run cluster onboarding screen`.

---

## Task 2: gate it in `AppContent`

**Files:** Modify `apps/web/src/App.tsx`.

READ: `App.tsx` around `AppContent` (the login/onboarding gating) and how `useContexts()` is imported/used.

- [ ] **Step 1:** In `AppContent`, add:
```tsx
  const { data: contexts } = useContexts();
  const [clusterSkipped, setClusterSkipped] = useState(false);
```
Then, before the main shell return (but after all hooks), gate:
```tsx
  if (contexts && contexts.length === 0 && !clusterSkipped) {
    return <ClusterOnboarding onSkip={() => setClusterSkipped(true)} />;
  }
```
Notes: gate only when `contexts` is loaded (truthy) AND empty — while `contexts` is `undefined` (loading) it renders the shell (the empty rail hides itself, so no ugly flash). When any of the create/connect/import flows adds a context, `useContexts` refetches → `contexts.length` > 0 → the gate falls through to the app automatically. `clusterSkipped` (component state) lets "Skip for now" through for the session.
- [ ] **Step 2:** Import `ClusterOnboarding` and `useContexts`. Keep the AI-agent onboarding logic below this untouched (a user who skips the cluster still gets the normal shell; the AI onboarding can still appear).
- [ ] **Step 3:** `pnpm --filter web typecheck` → clean; `pnpm --filter web test` → green (update any `<App>`/`<AppContent>` render test that now needs `useContexts` mocked to a non-empty list to reach the shell — mock it to return `[{...}]` so existing shell tests still pass; if a test renders AppContent signed-in, it may now hit the cluster gate — give it a non-empty contexts mock).
- [ ] **Step 4:** Commit `feat(web): gate first-run on having a cluster (onboarding wizard)`.

---

## Verification
- `pnpm --filter web typecheck` clean; `pnpm --filter web test` green.
- Live (desktop): a fresh install with no kubeconfig → after sign-in, the cluster wizard shows; "Create a local cluster" spins up kind/k3d and the wizard hands off to the app; existing clusters skip the wizard entirely; "Skip for now" enters the empty app.

## Self-review notes (author)
- Reuses the existing, tested Create/Connect/Import flows — no new cluster machinery, no backend change.
- Gate auto-dismisses via the `["contexts"]` query invalidation those flows already do; `clusterSkipped` is the soft escape.
- Only shows when contexts are loaded-and-empty, so users with clusters never see it.
