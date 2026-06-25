// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddClusterChooser } from "./AddClusterChooser";

test("offers create-local and connect-existing and fires the right callback", () => {
  const onCreateLocal = vi.fn();
  const onConnectExisting = vi.fn();
  render(<AddClusterChooser open onOpenChange={vi.fn()} onCreateLocal={onCreateLocal} onConnectExisting={onConnectExisting} />);

  fireEvent.click(screen.getByRole("button", { name: /create a local cluster/i }));
  expect(onCreateLocal).toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /connect to an existing cluster/i }));
  expect(onConnectExisting).toHaveBeenCalled();
});
