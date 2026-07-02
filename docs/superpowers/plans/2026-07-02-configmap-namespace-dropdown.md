# ConfigMap Modal Namespace Dropdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the free-text Namespace input in the ConfigMap create/edit modal with a live dropdown of the cluster's real namespaces, matching the house rule that every namespace input is a dropdown, never free text.

**Approach:** Reuse the same namespace source the shared `NamespaceBar` / `NamespaceMultiSelect` already use — the Zustand cluster store's `resources["namespaces"]` slice (`apps/web/src/store/cluster.ts`), fed by the ref-counted `subscribe("namespaces", "*")` / `unsubscribe` watch in `apps/web/src/lib/ws.ts`. `ConfigMapEditor` owns its own subscribe/unsubscribe pair while the dialog is open (identical filter to the always-mounted `NamespaceBar` watch, so ref-counting keeps it a no-op duplicate, not a clobbering second watch — this is the exact pattern `NamespaceMultiSelect` already uses). Style the `<select>` like the standardized dialog selects (`AlertSelect` in `apps/web/src/panels/assistant/AlertsCard.tsx:63`), adapted to `ConfigMapEditor`'s existing identity-field visual language. Namespace stays fixed (`LockedValue`) on edit; only create mode gets the dropdown, defaulted to the current shared namespace filter.

**Working dir for all commands:** `apps/web` (run `pnpm --filter web <script>` from repo root, or `cd apps/web` first). All file paths below are relative to the repo root `/Users/tyrelchambers/home/claude-k8s`.

**Key files:**
- `apps/web/src/panels/configmaps/ConfigMapEditor.tsx` — the component being changed (namespace field: lines 199–205; seed effect: lines 80–95; imports: lines 1–37).
- `apps/web/src/store/cluster.ts` — `resources` (kind → name → object map) and `namespaceFilter` (shared per-context selection) state.
- `apps/web/src/lib/ws.ts` — `subscribe`/`unsubscribe` (ref-counted per `kind`+`namespace` key; safe to call again for `"namespaces"`/`"*"` even though `NamespaceBar` already holds it open).
- `apps/web/src/shell/NamespaceBar.tsx:26-33` — the canonical pattern: owns a `subscribe("namespaces", "*")` effect, reads `Object.keys(resources["namespaces"] ?? {})`.
- `apps/web/src/panels/assistant/agents/NamespaceMultiSelect.tsx:21-36` — same pattern reused a second time inside a form component (own subscribe effect + `resources["namespaces"]` read + union with the current value so an already-selected namespace never disappears mid-load); its test file `NamespaceMultiSelect.test.tsx:8-18` shows how to seed `useCluster.setState({ resources: { namespaces: {...} } })` in tests.
- `apps/web/src/panels/assistant/AlertsCard.tsx:63-84` (`AlertSelect`) — the standardized native-`<select>` + chevron-overlay dialog pattern to mirror, and lines 442-458 for a namespace `<select>` populated from a namespaces list with an "options not loaded yet" fallback branch.
- `apps/web/src/panels/configmaps/ConfigMapsPanel.tsx:31-34,204-209` — confirms `ConfigMapEditor` is rendered without a `namespace` prop today; the editor must read `namespaceFilter` itself (`useCluster((s) => s.namespaceFilter)`), no prop plumbing needed.

**Create vs. edit:** `ConfigMapEditor` is a single component for both create and edit (`target: ConfigMap | null`, `isEdit = target != null`). On edit, Name and Namespace are both already rendered as `<LockedValue>` (read-only, "Preserved" badge) at lines 192-205 — this plan does **not** touch that branch. Only the create-mode branch (currently a free-text `TextField`) becomes the dropdown.

---

## Task 1: Wire the namespaces watch + options list into `ConfigMapEditor`

**File:** `apps/web/src/panels/configmaps/ConfigMapEditor.tsx`

- [ ] **Step 1: Import the store + ws subscribe helpers**

  Add to the top imports (after the `useClusterYamlSchema` import, `apps/web/src/panels/configmaps/ConfigMapEditor.tsx:34`):

  ```tsx
  import { useCluster } from "@/store/cluster";
  import { subscribe, unsubscribe } from "@/lib/ws";
  ```

- [ ] **Step 2: Read the store and own the namespaces watch while the dialog is open**

  Inside `ConfigMapEditor`, right after the existing `const { data: schema } = useClusterYamlSchema();` line (`ConfigMapEditor.tsx:74`), add:

  ```tsx
  const resources = useCluster((s) => s.resources);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  // Own the namespaces watch while the dialog is open (same "namespaces"/"*"
  // key the always-mounted NamespaceBar already holds — subscribe/unsubscribe
  // is ref-counted per kind+namespace in ws.ts, so this is a safe duplicate,
  // not a second differently-filtered watch on the same kind).
  useEffect(() => {
    if (!open) return;
    subscribe("namespaces", "*");
    return () => unsubscribe("namespaces", "*");
  }, [open]);
  ```

- [ ] **Step 3: Compute the namespace options list**

  Add a memo below the existing `yaml` memo (`ConfigMapEditor.tsx:99-103`):

  ```tsx
  // Cluster namespaces, unioned with whatever is currently selected so the
  // field never goes blank mid-load (mirrors NamespaceMultiSelect).
  const namespaceOptions = useMemo(() => {
    const fromCluster = Object.keys(resources["namespaces"] ?? {});
    return Array.from(new Set([...fromCluster, ...(namespace ? [namespace] : [])])).sort((a, b) =>
      a.localeCompare(b),
    );
  }, [resources, namespace]);
  ```

- [ ] **Step 4: Default the create-mode namespace to the current shared filter**

  In the seed effect (`ConfigMapEditor.tsx:80-95`), change the create branch's hardcoded default:

  ```tsx
  } else {
      setName("");
      setNamespace("default");
      setRows([blankRow()]);
  }
  ```

  to default to the app's current namespace selection when one is set ("All namespaces" → falls back to `"default"`):

  ```tsx
  } else {
      setName("");
      setNamespace(namespaceFilter ?? "default");
      setRows([blankRow()]);
  }
  ```

**Verify:** `pnpm --filter web typecheck` (from repo root) — no new errors.

---

## Task 2: Replace the free-text namespace field with a styled dropdown (create mode only)

**File:** `apps/web/src/panels/configmaps/ConfigMapEditor.tsx`

- [ ] **Step 1: Add the `ChevronDown` icon import**

  Add `ChevronDown` to the existing `lucide-react` import block (`ConfigMapEditor.tsx:2-13`).

- [ ] **Step 2: Add a `NamespaceSelectField` component**

  Add this next to `TextField` (after `TextField`, before `LockedValue`, i.e. after `ConfigMapEditor.tsx:342`). It mirrors `TextField`'s exact visual language (same border/background/padding/font sizing as the rest of the Identity row) with a native `<select>` + chevron overlay, matching the standardized dialog-select pattern (`AlertSelect` in `AlertsCard.tsx:63-84`):

  ```tsx
  function NamespaceSelectField({
    value,
    onChange,
    options,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: string[];
  }) {
    return (
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Namespace"
          className="w-full cursor-pointer appearance-none rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[14px] py-[12px] pr-9 font-mono text-[14px] text-[var(--fg-primary)] outline-none transition-colors focus:border-[var(--accent-primary)]"
        >
          {options.length > 0 ? (
            options.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))
          ) : (
            <option value={value}>{value}</option>
          )}
        </select>
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-[14px] size-[15px] -translate-y-1/2 text-[var(--fg-tertiary)]"
          aria-hidden
        />
      </div>
    );
  }
  ```

- [ ] **Step 3: Swap the create-mode Namespace field**

  In the Identity block (`ConfigMapEditor.tsx:199-205`), replace:

  ```tsx
  <IdentityField label="Namespace" locked={isEdit}>
    {isEdit ? (
      <LockedValue value={namespace} />
    ) : (
      <TextField value={namespace} onChange={setNamespace} placeholder="default" />
    )}
  </IdentityField>
  ```

  with:

  ```tsx
  <IdentityField label="Namespace" locked={isEdit}>
    {isEdit ? (
      <LockedValue value={namespace} />
    ) : (
      <NamespaceSelectField value={namespace} onChange={setNamespace} options={namespaceOptions} />
    )}
  </IdentityField>
  ```

**Verify:** `pnpm --filter web typecheck` and `pnpm --filter web build` (from repo root) — no errors.

---

## Task 3: Test coverage

**File (new):** `apps/web/src/panels/configmaps/ConfigMapEditor.test.tsx`

Follow the patterns in `apps/web/src/panels/configmaps/ConfigMapDetail.test.tsx` (fetch stub, `wrap()` with `QueryClientProvider`) and `apps/web/src/panels/assistant/agents/NamespaceMultiSelect.test.tsx` (seeding `useCluster.setState` with a `resources.namespaces` map).

- [ ] **Step 1: Write the test file**

  ```tsx
  // @vitest-environment jsdom
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import type { ReactElement } from "react";
  import { render, screen } from "@testing-library/react";
  import userEvent from "@testing-library/user-event";
  import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
  import { useCluster } from "@/store/cluster";
  import { ConfigMapEditor } from "./ConfigMapEditor";
  import type { ConfigMap } from "./types";

  function wrap(ui: ReactElement) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  }

  const target: ConfigMap = {
    metadata: { name: "app-config", namespace: "kube-system", uid: "c1", creationTimestamp: new Date().toISOString() },
    data: { key: "value" },
  };

  beforeEach(() => {
    useCluster.setState({
      resources: {
        namespaces: {
          default: { metadata: { name: "default" } },
          "kube-system": { metadata: { name: "kube-system" } },
          monitoring: { metadata: { name: "monitoring" } },
        },
      },
      namespaceFilter: null,
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, stdout: "", stderr: "" }) })));
  });

  describe("ConfigMapEditor — namespace field", () => {
    it("create mode renders a namespace dropdown populated from the cluster store", () => {
      wrap(<ConfigMapEditor target={null} open onClose={() => {}} />);
      const select = screen.getByLabelText("Namespace") as HTMLSelectElement;
      const optionValues = Array.from(select.options).map((o) => o.value);
      expect(optionValues).toEqual(["default", "kube-system", "monitoring"]);
    });

    it("create mode defaults to the current shared namespace filter", () => {
      useCluster.setState({ namespaceFilter: "monitoring" });
      wrap(<ConfigMapEditor target={null} open onClose={() => {}} />);
      const select = screen.getByLabelText("Namespace") as HTMLSelectElement;
      expect(select.value).toBe("monitoring");
    });

    it("create mode falls back to 'default' when no namespace filter is set", () => {
      wrap(<ConfigMapEditor target={null} open onClose={() => {}} />);
      const select = screen.getByLabelText("Namespace") as HTMLSelectElement;
      expect(select.value).toBe("default");
    });

    it("selecting a namespace updates the select's value (drives the YAML build via buildConfigMapYAML)", async () => {
      wrap(<ConfigMapEditor target={null} open onClose={() => {}} />);
      const select = screen.getByLabelText("Namespace") as HTMLSelectElement;
      await userEvent.selectOptions(select, "monitoring");
      expect(select.value).toBe("monitoring");
    });

    it("edit mode shows the namespace as a locked, non-editable value", () => {
      wrap(<ConfigMapEditor target={target} open onClose={() => {}} />);
      expect(screen.queryByLabelText("Namespace")).not.toBeInTheDocument();
      expect(screen.getByText("kube-system")).toBeTruthy();
      expect(screen.getByText("Preserved")).toBeTruthy();
    });
  });
  ```

  Note: the Form ⇄ YAML toggle renders the YAML tab through the Monaco-based `YamlEditor` (`apps/web/src/components/YamlEditorLazy.tsx`), which no existing test in this repo exercises (it's lazy-loaded and heavy in jsdom). Don't add a first test against it here — the select's own `value` plus the existing `buildConfigMapYAML`/`canSubmitConfigMap` unit coverage in `packages/k8s/src/configmapSecretEditor.test.ts` already prove the namespace flows into the applied manifest; keep this test file scoped to the dropdown's DOM behavior.

- [ ] **Step 2: Run the new test file**

  ```
  pnpm --filter web test -- ConfigMapEditor
  ```

  All 5 cases pass.

**Verify:** `pnpm --filter web test` (full suite, from repo root) — no regressions.

---

## Task 4: Final verification

- [ ] `pnpm --filter web typecheck`
- [ ] `pnpm --filter web test`
- [ ] `pnpm --filter web build`
- [ ] Manual sanity read-through: confirm `ConfigMapsPanel.tsx` still renders `<ConfigMapEditor>` with only `target`/`open`/`onClose`/`onApplied` (no new required props leaked out), since the editor now sources namespace data itself via the store.
