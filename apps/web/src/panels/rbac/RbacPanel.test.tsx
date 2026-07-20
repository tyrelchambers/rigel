// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/lib/chatHandoff", () => ({ handoffToChat: vi.fn() }));
vi.mock("@/shell/NamespaceBar", () => ({ NamespaceSelector: () => null }));
vi.mock("@/store/yamlViewer", () => ({ editYaml: vi.fn(), viewYaml: vi.fn() }));
vi.mock("@/components/ConfirmSheet", () => ({
  ConfirmSheet: ({ open, action }: { open: boolean; action: { label?: string } | null }) =>
    open ? <div data-testid="confirm">{action?.label}</div> : null,
}));

const state: {
  resources: Record<string, Record<string, unknown>>;
  isLoading: boolean;
  error: string | null;
  namespaceFilter: string | null;
} = { resources: {}, isLoading: false, error: null, namespaceFilter: null };

vi.mock("@/store/cluster", () => ({
  useCluster: (sel: (s: typeof state) => unknown) => sel(state),
  filterByNamespace: (slice: Record<string, unknown> | undefined, ns: string | null) => {
    const all = Object.values(slice ?? {});
    if (ns == null) return all;
    return all.filter((o) => {
      const n = (o as { metadata?: { namespace?: string } })?.metadata?.namespace;
      return n === undefined || n === ns;
    });
  },
}));

import RbacPanel from "./RbacPanel";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ resources: [], groups: [] }))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <RbacPanel />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function setResources(r: Record<string, Record<string, unknown>>) {
  state.resources = {
    roles: {},
    clusterroles: {},
    rolebindings: {},
    clusterrolebindings: {},
    ...r,
  };
}

test("renders the subject derived from a binding", () => {
  setResources({
    rolebindings: {
      "1": {
        metadata: { name: "b1", namespace: "default", uid: "1" },
        roleRef: { kind: "Role", name: "reader" },
        subjects: [{ kind: "ServiceAccount", name: "rigel-agent", namespace: "default" }],
      },
    },
    roles: {
      "2": {
        metadata: { name: "reader", namespace: "default", uid: "2" },
        rules: [{ verbs: ["get"], resources: ["pods"] }],
      },
    },
  });
  renderPanel();
  expect(screen.getByText("RBAC")).toBeTruthy();
  expect(screen.getAllByText("rigel-agent").length).toBeGreaterThan(0);
});

// Regression for the scope-resolution bug: a namespaced RoleBinding that
// references a ClusterRole must still resolve that ClusterRole's rules under
// "Namespaced" scope — otherwise the subject's rules vanish and DANGEROUS
// under-reports to 0.
test("Namespaced scope resolves a RoleBinding→ClusterRole grant and keeps it dangerous", () => {
  setResources({
    rolebindings: {
      "1": {
        metadata: { name: "grant-admin", namespace: "default", uid: "1" },
        roleRef: { kind: "ClusterRole", name: "admin" },
        subjects: [{ kind: "ServiceAccount", name: "app", namespace: "default" }],
      },
    },
    clusterroles: {
      "2": {
        metadata: { name: "admin", uid: "2" },
        rules: [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }],
      },
    },
  });
  renderPanel();

  fireEvent.click(screen.getByRole("tab", { name: "Namespaced" }));

  // DANGEROUS count stays 1 (scoped to just the DANGEROUS stat, since other
  // counts also read 1 in this fixture).
  const dangerousStat = screen.getByText("DANGEROUS").parentElement as HTMLElement;
  expect(within(dangerousStat).getByText("1")).toBeTruthy();

  // The binding card shows the ClusterRole ref and its resolved rules, not the
  // "Role not found in scope" fallback.
  expect(screen.getByText("ClusterRole/admin")).toBeTruthy();
  expect(screen.queryByText(/Role not found in scope/)).toBeNull();
});

test("deleting a role opens the confirm sheet", () => {
  setResources({
    clusterroles: {
      "2": { metadata: { name: "admin", uid: "2" }, rules: [{ verbs: ["*"], resources: ["*"] }] },
    },
    clusterrolebindings: {
      "1": {
        metadata: { name: "cadmin", uid: "1" },
        roleRef: { kind: "ClusterRole", name: "admin" },
        subjects: [{ kind: "Group", name: "system:masters" }],
      },
    },
  });
  renderPanel();
  fireEvent.click(screen.getByRole("tab", { name: "Roles" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
  expect(screen.getByTestId("confirm").textContent).toContain("Delete clusterrole admin");
});

test("editing a role opens the RoleEditor and applying opens the confirm sheet", () => {
  setResources({
    clusterroles: {
      "2": { metadata: { name: "admin", uid: "2" }, rules: [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }] },
    },
  });
  renderPanel();
  fireEvent.click(screen.getByRole("tab", { name: "Roles" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
  // RoleEditor mounted
  expect(screen.getByText(/Edit role · admin/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  expect(screen.getByTestId("confirm").textContent).toContain("Apply ClusterRole admin");
});

test("editing a binding opens the BindingEditor and applies", () => {
  setResources({
    rolebindings: {
      "1": {
        metadata: { name: "b1", namespace: "default", uid: "1" },
        roleRef: { kind: "ClusterRole", name: "admin" },
        subjects: [{ kind: "ServiceAccount", name: "app", namespace: "default" }],
      },
    },
    clusterroles: { "2": { metadata: { name: "admin", uid: "2" }, rules: [{ verbs: ["*"], resources: ["*"] }] } },
  });
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Edit binding" }));
  expect(screen.getByText(/Edit binding · b1/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  expect(screen.getByTestId("confirm").textContent).toContain("Apply RoleBinding b1");
});

test("New menu creates a role", () => {
  setResources({});
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "New RBAC object" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "ClusterRole" }));
  expect(screen.getByText("New role")).toBeTruthy();
});
