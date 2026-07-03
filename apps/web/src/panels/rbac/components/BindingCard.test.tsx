// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BindingCard } from "./BindingCard";
import type { Grant } from "../types";

afterEach(cleanup);

const grant: Grant = {
  bindingName: "rigel-agent",
  bindingKind: "RoleBinding",
  roleRef: { kind: "Role", name: "rigel-agent" },
  scope: { kind: "Namespaced", namespace: "default" },
  rules: [
    { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
    { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
  ],
};

test("renders binding name, roleRef, scope, and rule count", () => {
  render(<BindingCard grant={grant} />);
  expect(screen.getByText("rigel-agent")).toBeTruthy();
  expect(screen.getByText("Role/rigel-agent")).toBeTruthy();
  expect(screen.getByText("default")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy(); // rules count
  expect(screen.getByText("secrets")).toBeTruthy();
});
