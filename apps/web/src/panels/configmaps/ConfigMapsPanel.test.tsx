// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/lib/chatHandoff", () => ({ handoffToChat: vi.fn() }));
vi.mock("@/store/yamlViewer", () => ({ editYaml: vi.fn(), viewYaml: vi.fn() }));
vi.mock("./ConfigMapEditor", () => ({ ConfigMapEditor: () => null }));

const state: {
  resources: Record<string, Record<string, unknown>>;
  isLoading: boolean;
  error: string | null;
  namespaceFilter: string | null;
  accessByKind: Record<string, { status: "ok" | "forbidden" | "error" }>;
} = { resources: {}, isLoading: false, error: null, namespaceFilter: null, accessByKind: {} };

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

import ConfigMapsPanel from "./ConfigMapsPanel";

afterEach(cleanup);

test("shows the no-access notice when the namespace-filtered list is empty and forbidden", () => {
  state.resources = { configmaps: {} };
  state.accessByKind = { configmaps: { status: "forbidden" } };
  render(<ConfigMapsPanel />);
  expect(screen.getByText("No access to configmaps.")).toBeInTheDocument();
});

test("hides the no-access notice when there are rows to show, even if another namespace is forbidden", () => {
  state.resources = {
    configmaps: {
      "1": { metadata: { name: "cm-a", namespace: "default", uid: "1" }, data: { k: "v" } },
    },
  };
  state.accessByKind = { configmaps: { status: "forbidden" } };
  render(<ConfigMapsPanel />);
  expect(screen.getByText("cm-a")).toBeInTheDocument();
  expect(screen.queryByText(/no access to configmaps/i)).not.toBeInTheDocument();
});
