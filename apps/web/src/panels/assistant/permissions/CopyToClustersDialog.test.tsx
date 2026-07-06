// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyToClustersDialog } from "./CopyToClustersDialog";

test("confirms with the checked subset of other clusters", async () => {
  const onConfirm = vi.fn();
  render(
    <CopyToClustersDialog
      open
      onOpenChange={() => {}}
      clusters={[{ name: "prod", active: false }, { name: "dev", active: false }]}
      confirming={false}
      onConfirm={onConfirm}
    />,
  );
  await userEvent.click(screen.getByRole("checkbox", { name: "prod" }));
  await userEvent.click(screen.getByRole("button", { name: /copy/i }));
  expect(onConfirm).toHaveBeenCalledWith(["prod"]);
});

test("confirm is disabled until at least one cluster is checked", () => {
  render(
    <CopyToClustersDialog open onOpenChange={() => {}}
      clusters={[{ name: "prod", active: false }]} confirming={false} onConfirm={() => {}} />,
  );
  expect(screen.getByRole("button", { name: /copy/i })).toBeDisabled();
});
