// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccountModal } from "./AccountModal";

afterEach(cleanup);

test("shows the name, email, plan badge, and actions", () => {
  render(<AccountModal open onOpenChange={vi.fn()} name="Tyrel Chambers" email="tychambers3@gmail.com" />);
  expect(screen.getByText("Tyrel Chambers")).toBeTruthy();
  expect(screen.getByText("tychambers3@gmail.com")).toBeTruthy();
  expect(screen.getByText("Free")).toBeTruthy();
  expect(screen.getByText("Sign out")).toBeTruthy();
  expect(screen.getByText("Done")).toBeTruthy();
});

test("Done closes the modal", () => {
  const onOpenChange = vi.fn();
  render(<AccountModal open onOpenChange={onOpenChange} name="A" email="a@b.com" />);
  fireEvent.click(screen.getByText("Done"));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
