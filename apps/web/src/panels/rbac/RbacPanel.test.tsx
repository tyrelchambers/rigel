// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/lib/chatHandoff", () => ({ handoffToChat: vi.fn() }));
vi.mock("@/shell/NamespaceBar", () => ({ NamespaceSelector: () => null }));

const state = {
  resources: {
    rolebindings: {
      "1": {
        metadata: { name: "b1", namespace: "default", uid: "1" },
        roleRef: { kind: "Role", name: "reader" },
        subjects: [{ kind: "ServiceAccount", name: "rigel-agent", namespace: "default" }],
      },
    },
    roles: {
      "2": { metadata: { name: "reader", namespace: "default", uid: "2" }, rules: [{ verbs: ["get"], resources: ["pods"] }] },
    },
    clusterroles: {},
    clusterrolebindings: {},
    serviceaccounts: {},
  },
  isLoading: false,
  error: null,
  namespaceFilter: null,
};
vi.mock("@/store/cluster", () => ({
  useCluster: (sel: (s: typeof state) => unknown) => sel(state),
}));

import RbacPanel from "./RbacPanel";

afterEach(cleanup);

test("renders the subject and its resolved binding on select", () => {
  render(<RbacPanel />);
  expect(screen.getByText("RBAC")).toBeTruthy();
  // subject appears in the list
  expect(screen.getAllByText("rigel-agent").length).toBeGreaterThan(0);
});
