// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RemoveClusterDialog } from "./RemoveClusterDialog";

const baseProps = {
  cluster: { name: "do-tor1-k8s-1-36-0-do-2-tor1-1782419851033", server: "https://abc.k8s.ondigitalocean.com" },
  open: true,
  onOpenChange: vi.fn(),
  onConfirm: vi.fn(),
};

test("renders the lead question", () => {
  render(<RemoveClusterDialog {...baseProps} />);
  expect(screen.getByText(/remove this cluster from rigel/i)).toBeInTheDocument();
});

test("renders the cluster name", () => {
  render(<RemoveClusterDialog {...baseProps} />);
  expect(screen.getByText("do-tor1-k8s-1-36-0-do-2-tor1-1782419851033")).toBeInTheDocument();
});

test("renders the provider label for DigitalOcean", () => {
  render(<RemoveClusterDialog {...baseProps} />);
  expect(screen.getByText(/digitalocean/i)).toBeInTheDocument();
});

test("renders the reassurance copy", () => {
  render(<RemoveClusterDialog {...baseProps} />);
  expect(screen.getByText(/keeps running/i)).toBeInTheDocument();
});

test("fires onConfirm when the confirm button is clicked", () => {
  const onConfirm = vi.fn();
  render(<RemoveClusterDialog {...baseProps} onConfirm={onConfirm} />);
  fireEvent.click(screen.getByRole("button", { name: /remove from rigel/i }));
  expect(onConfirm).toHaveBeenCalledOnce();
});

test("fires onOpenChange(false) when Cancel is clicked", () => {
  const onOpenChange = vi.fn();
  render(<RemoveClusterDialog {...baseProps} onOpenChange={onOpenChange} />);
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("shows 'Removing…' and the confirm button is disabled when busy", () => {
  render(<RemoveClusterDialog {...baseProps} busy />);
  const btn = screen.getByRole("button", { name: /removing/i });
  expect(btn).toBeDisabled();
});
