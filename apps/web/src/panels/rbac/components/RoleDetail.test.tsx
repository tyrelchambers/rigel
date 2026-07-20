// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { RoleDetail } from "./RoleDetail";

afterEach(cleanup);

test("fires edit and delete actions", () => {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(
    <MemoryRouter>
      <RoleDetail
        roleName="admin"
        roleKind="ClusterRole"
        rules={[{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }]}
        boundSubjects={[]}
        onEdit={onEdit}
        onDelete={onDelete}
        onEditYaml={vi.fn()}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
  expect(onEdit).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
  expect(onDelete).toHaveBeenCalled();
});

test("assistant-managed role hides inline editing and links to Permissions", () => {
  render(
    <MemoryRouter>
      <RoleDetail
        roleName="rigel-assistant"
        roleKind="ClusterRole"
        rules={[]}
        boundSubjects={[]}
        assistantManaged
      />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("button", { name: "Edit role" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete role" })).toBeNull();
  expect(screen.getByRole("button", { name: /manage in assistant/i })).toBeInTheDocument();
  expect(screen.getByText(/edit it under assistant/i)).toBeInTheDocument();
});
