// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RbacList } from "./RbacList";
import type { ListSubject } from "../types";

afterEach(cleanup);

const subjects: ListSubject[] = [
  { key: "a", kind: "ServiceAccount", name: "rigel-agent", namespace: "default", dangerous: true },
  { key: "b", kind: "Group", name: "system:authenticated", dangerous: false },
];

test("renders subjects and fires selection", () => {
  const onSelect = vi.fn();
  render(
    <RbacList
      view="subjects"
      onViewChange={vi.fn()}
      subjects={subjects}
      roleItems={[]}
      selectedKey="a"
      onSelectSubject={onSelect}
      onSelectRole={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("system:authenticated"));
  expect(onSelect).toHaveBeenCalledWith(subjects[1]);
});

test("switches to roles view", () => {
  const onView = vi.fn();
  render(
    <RbacList
      view="subjects"
      onViewChange={onView}
      subjects={subjects}
      roleItems={[]}
      selectedKey={null}
      onSelectSubject={vi.fn()}
      onSelectRole={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Roles" }));
  expect(onView).toHaveBeenCalledWith("roles");
});
