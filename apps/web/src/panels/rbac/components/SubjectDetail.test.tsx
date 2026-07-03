// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SubjectDetail } from "./SubjectDetail";
import type { Grant, ListSubject } from "../types";

afterEach(cleanup);

const subject: ListSubject = {
  key: "a",
  kind: "ServiceAccount",
  name: "rigel-agent",
  namespace: "default",
  dangerous: true,
};
const grants: Grant[] = [
  {
    bindingName: "rigel-agent",
    bindingKind: "RoleBinding",
    roleRef: { kind: "Role", name: "rigel-agent" },
    scope: { kind: "Namespaced", namespace: "default" },
    rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get"] }],
  },
];

test("shows summary counts and fires Ask handoff", () => {
  const onAsk = vi.fn();
  render(<SubjectDetail subject={subject} grants={grants} onAsk={onAsk} />);
  expect(screen.getByText("1 role bound")).toBeTruthy();
  expect(screen.getByText("1 dangerous grant")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Ask Rigel about access/ }));
  expect(onAsk).toHaveBeenCalledWith(subject);
});
