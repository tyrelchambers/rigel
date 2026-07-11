// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoleEditor, verbSuggestionsForResources } from "./RoleEditor";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/api-resources")) {
        return new Response(JSON.stringify({
          resources: ["pods", "deployments"],
          groups: ["core", "apps"],
          verbsByResource: { pods: ["get", "list", "watch"], deployments: ["create", "get", "patch"] },
        }));
      }
      return new Response("{}");
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const role = {
  kind: "ClusterRole" as const,
  name: "reader",
  rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }],
};

function renderEditor(props: Partial<ComponentProps<typeof RoleEditor>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoleEditor target={role} open onClose={vi.fn()} onApply={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

test("edits a rule token and applies the built manifest", () => {
  const onApply = vi.fn();
  renderEditor({ onApply });
  // add a verb
  const addVerb = screen.getByLabelText("Add VERBS");
  fireEvent.change(addVerb, { target: { value: "list" } });
  fireEvent.keyDown(addVerb, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
  expect(onApply).toHaveBeenCalledTimes(1);
  const { yaml, label } = onApply.mock.calls[0][0];
  expect(label).toBe("Apply ClusterRole reader");
  expect(yaml).toContain("verbs: ['get', 'list']");
  expect(yaml).toContain("kind: ClusterRole");
});

test("adds and removes a rule", () => {
  renderEditor();
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  expect(screen.getAllByText(/^Rule \d/).length).toBe(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Remove rule" })[1]);
  expect(screen.getAllByText(/^Rule \d/).length).toBe(1);
});

test("verbSuggestionsForResources: unions picked resources' verbs + '*'", () => {
  const vbr = { pods: ["get", "list"], deployments: ["create", "get"] };
  expect(verbSuggestionsForResources(["pods", "deployments"], vbr)).toEqual(["*", "create", "get", "list"]);
});

test("verbSuggestionsForResources: no data → full RBAC verb list", () => {
  expect(verbSuggestionsForResources([], {})).toContain("deletecollection");
  expect(verbSuggestionsForResources(["crd-not-registered"], { pods: ["get"] })).toContain("escalate");
});

function renderNew(props: Partial<ComponentProps<typeof RoleEditor>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoleEditor target={null} open onClose={vi.fn()} onApply={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

test("preset seeds the rules and Apply builds them", () => {
  const onApply = vi.fn();
  renderNew({ onApply });
  fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "reader" } });
  fireEvent.click(screen.getByRole("button", { name: "Read-only" }));
  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  const { yaml } = onApply.mock.calls[0][0];
  expect(yaml).toContain("verbs: ['get', 'list', 'watch']");
  expect(yaml).toContain("resources: ['*']");
});
