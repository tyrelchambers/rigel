// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/store/cluster", () => {
  const useCluster = (sel: (s: { resources: Record<string, Record<string, unknown>> }) => unknown) =>
    sel({ resources: { namespaces: { default: {} } } });
  useCluster.getState = () => ({ activeContext: null });
  return { useCluster };
});

import { BindingEditor } from "./BindingEditor";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const binding = {
  kind: "RoleBinding" as const,
  name: "b1",
  namespace: "default",
  roleRef: { kind: "ClusterRole", name: "admin" },
  subjects: [{ kind: "ServiceAccount", name: "app", namespace: "default" }],
};

test("applying builds a manifest with the subjects", () => {
  const onApply = vi.fn();
  render(<BindingEditor target={binding} open onClose={vi.fn()} onApply={onApply} />);
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  const { yaml, label } = onApply.mock.calls[0][0];
  expect(label).toBe("Apply RoleBinding b1");
  expect(yaml).toContain("kind: ServiceAccount");
  expect(yaml).toContain("name: 'app'");
  expect(yaml).toContain("kind: ClusterRole");
});

test("removing a subject drops it from the manifest", () => {
  const onApply = vi.fn();
  render(<BindingEditor target={binding} open onClose={vi.fn()} onApply={onApply} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove subject app" }));
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  expect(onApply.mock.calls[0][0].yaml).toContain("subjects: []");
});

test("subject namespace is disabled for non-ServiceAccount subjects", () => {
  render(
    <BindingEditor
      target={{ ...binding, subjects: [{ kind: "Group", name: "g" }] }}
      open
      onClose={vi.fn()}
      onApply={vi.fn()}
    />,
  );
  expect((screen.getByLabelText("Subject namespace") as HTMLSelectElement).disabled).toBe(true);
});

test("roleRef name is a dropdown filtered to the binding's scope", () => {
  const onApply = vi.fn();
  render(
    <BindingEditor
      target={{ kind: "RoleBinding", name: "b1", namespace: "default", roleRef: { kind: "Role", name: "" }, subjects: [] }}
      open
      onClose={vi.fn()}
      onApply={onApply}
      roleOptions={[
        { kind: "Role", name: "reader", namespace: "default" },
        { kind: "Role", name: "editor", namespace: "other" },
      ]}
    />,
  );
  const roleSelect = screen.getByLabelText("Role ref name");
  expect(screen.getByRole("option", { name: "reader" })).toBeTruthy();
  // a Role in another namespace is not offered
  expect(screen.queryByRole("option", { name: "editor" })).toBeNull();
  fireEvent.change(roleSelect, { target: { value: "reader" } });
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  expect(onApply.mock.calls[0][0].yaml).toContain("name: 'reader'");
});

test("nameSuggestion auto-fills the create-mode name until the user edits it", () => {
  render(
    <BindingEditor
      target={{ kind: "ClusterRoleBinding", name: "", roleRef: { kind: "ClusterRole", name: "" }, subjects: [] }}
      open
      onClose={vi.fn()}
      onApply={vi.fn()}
      roleOptions={[
        { kind: "ClusterRole", name: "view" },
        { kind: "ClusterRole", name: "edit" },
      ]}
      nameSuggestion={(r) => (r ? `rigel-assistant-${r}` : "")}
    />,
  );
  const nameInput = screen.getByLabelText("Binding name") as HTMLInputElement;
  const roleSelect = screen.getByLabelText("Role ref name");
  // picking a role suggests the name
  fireEvent.change(roleSelect, { target: { value: "view" } });
  expect(nameInput.value).toBe("rigel-assistant-view");
  // once the user edits the name, later role changes don't clobber it
  fireEvent.change(nameInput, { target: { value: "custom-name" } });
  fireEvent.change(roleSelect, { target: { value: "edit" } });
  expect(nameInput.value).toBe("custom-name");
});

test("renders a per-subject access test when a role and subject are set", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/api/rbac/can-i")) {
      return new Response(JSON.stringify({
        results: [{ subject: { kind: "ServiceAccount", name: "sa", namespace: "default" }, checks: [
          { verb: "get", resource: "pods", apiGroup: "", allowed: false },
        ] }],
        note: undefined,
      }));
    }
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <BindingEditor
      target={{
        kind: "RoleBinding", name: "rb", namespace: "default",
        roleRef: { kind: "Role", name: "reader" },
        subjects: [{ kind: "ServiceAccount", name: "sa", namespace: "default" }],
      }}
      open
      onClose={vi.fn()}
      onApply={vi.fn()}
      rulesForRole={() => [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }]}
    />,
  );

  const btn = screen.getAllByRole("button", { name: /Test access/ })[0];
  fireEvent.click(btn);
  expect(await screen.findByText(/granted by this binding/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/rbac/can-i", expect.objectContaining({ method: "POST" }));
});
