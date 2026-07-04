// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoleEditor } from "./RoleEditor";

afterEach(cleanup);

const role = {
  kind: "ClusterRole" as const,
  name: "reader",
  rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }],
};

test("edits a rule token and applies the built manifest", () => {
  const onApply = vi.fn();
  render(<RoleEditor target={role} open onClose={vi.fn()} onApply={onApply} />);
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
  render(<RoleEditor target={role} open onClose={vi.fn()} onApply={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  expect(screen.getAllByText(/^Rule \d/).length).toBe(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Remove rule" })[1]);
  expect(screen.getAllByText(/^Rule \d/).length).toBe(1);
});
