// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClusterIconPicker } from "./ClusterIconPicker";

const baseProps = {
  contextName: "my-cluster",
  currentId: null as null | import("./clusterIcons").IconId,
  onPick: vi.fn(),
  onClose: vi.fn(),
};

test("renders 'Remove from Rigel' button when removable and onRemove are provided", () => {
  render(<ClusterIconPicker {...baseProps} removable onRemove={vi.fn()} />);
  expect(screen.getByRole("button", { name: /remove from rigel/i })).toBeInTheDocument();
});

test("fires onRemove when the Remove from Rigel button is clicked", () => {
  const onRemove = vi.fn();
  render(<ClusterIconPicker {...baseProps} removable onRemove={onRemove} />);
  fireEvent.click(screen.getByRole("button", { name: /remove from rigel/i }));
  expect(onRemove).toHaveBeenCalledOnce();
});

test("does NOT render 'Remove from Rigel' when removable is false", () => {
  render(<ClusterIconPicker {...baseProps} removable={false} onRemove={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /remove from rigel/i })).toBeNull();
});

test("does NOT render 'Remove from Rigel' when onRemove is absent", () => {
  render(<ClusterIconPicker {...baseProps} removable />);
  expect(screen.queryByRole("button", { name: /remove from rigel/i })).toBeNull();
});

test("still renders Delete cluster button when deletable and onDelete are provided", () => {
  render(<ClusterIconPicker {...baseProps} deletable onDelete={vi.fn()} />);
  expect(screen.getByRole("button", { name: /delete cluster/i })).toBeInTheDocument();
});
