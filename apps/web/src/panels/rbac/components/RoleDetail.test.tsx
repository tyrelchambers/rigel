// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoleDetail } from "./RoleDetail";

afterEach(cleanup);

test("fires edit and delete actions", () => {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(
    <RoleDetail
      roleName="admin"
      roleKind="ClusterRole"
      rules={[{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }]}
      boundSubjects={[]}
      onEdit={onEdit}
      onDelete={onDelete}
      onEditYaml={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
  expect(onEdit).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
  expect(onDelete).toHaveBeenCalled();
});
