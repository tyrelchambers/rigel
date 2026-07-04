// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/store/cluster", () => ({
  useCluster: (sel: (s: { resources: Record<string, Record<string, unknown>> }) => unknown) =>
    sel({
      resources: {
        namespaces: { default: {}, rigel: {} },
        roles: {},
        clusterroles: { "1": { metadata: { name: "view" } } },
      },
    }),
}));
vi.mock("@/components/ConfirmSheet", () => ({
  ConfirmSheet: ({ open, action }: { open: boolean; action: { label?: string; manifest?: string } | null }) =>
    open ? <div data-testid="confirm">{`${action?.label ?? ""}\n${action?.manifest ?? ""}`}</div> : null,
}));

import { GrantRoleButton } from "./GrantRoleButton";

afterEach(cleanup);

test("grants the assistant a clusterrole via a pre-seeded binding", () => {
  render(<GrantRoleButton namespace="rigel" />);
  fireEvent.click(screen.getByRole("button", { name: /Grant a role/ }));

  // Binding editor opens in create mode with the assistant SA pre-seeded.
  expect(screen.getByText("New binding")).toBeTruthy();
  expect((screen.getByLabelText("Subject name") as HTMLInputElement).value).toBe("rigel-assistant");

  // Name the binding and pick the clusterrole.
  fireEvent.change(screen.getByLabelText("Binding name"), { target: { value: "rigel-assistant-view" } });
  fireEvent.change(screen.getByLabelText("Role ref name"), { target: { value: "view" } });
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));

  const confirm = screen.getByTestId("confirm").textContent ?? "";
  expect(confirm).toContain("Apply ClusterRoleBinding rigel-assistant-view");
  expect(confirm).toContain("kind: ServiceAccount");
  expect(confirm).toContain("name: 'rigel-assistant'");
  expect(confirm).toContain("namespace: 'rigel'");
  expect(confirm).toContain("kind: ClusterRole");
  expect(confirm).toContain("name: 'view'");
});
