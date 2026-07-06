// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_POLICY, setCapability } from "@rigel/k8s";
import { CopyToClustersDialog } from "./CopyToClustersDialog";

test("confirms with the checked subset of other clusters", async () => {
  const onConfirm = vi.fn();
  render(
    <CopyToClustersDialog
      open
      onOpenChange={() => {}}
      clusters={[{ name: "prod", active: false }, { name: "dev", active: false }]}
      applied={{ cells: [] }}
      staged={{ cells: [] }}
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
      clusters={[{ name: "prod", active: false }]}
      applied={{ cells: [] }} staged={{ cells: [] }} confirming={false} onConfirm={() => {}} />,
  );
  expect(screen.getByRole("button", { name: /copy/i })).toBeDisabled();
});

test("shows the diff being pushed above the cluster list", () => {
  const staged = setCapability(DEFAULT_POLICY, "deleteWorkloads", true);
  render(
    <CopyToClustersDialog open onOpenChange={() => {}}
      clusters={[{ name: "prod", active: false }]}
      applied={DEFAULT_POLICY} staged={staged} confirming={false} onConfirm={() => {}} />,
  );
  expect(screen.getByText("+ delete deployments")).toBeInTheDocument();
});
