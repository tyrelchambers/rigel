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

test("a local cluster shows BOTH actions, with Disconnect before the destructive Delete", () => {
  // A local (kind/k3d) cluster is both deletable and removable; the operator must
  // be able to disconnect without destroying the container, and Disconnect leads.
  render(<ClusterIconPicker {...baseProps} deletable onDelete={vi.fn()} removable onRemove={vi.fn()} />);
  const remove = screen.getByRole("button", { name: /remove from rigel/i });
  const del = screen.getByRole("button", { name: /delete cluster/i });
  expect(remove).toBeInTheDocument();
  expect(del).toBeInTheDocument();
  // Disconnect renders first (primary); the destructive Delete follows it in the DOM.
  expect(remove.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
