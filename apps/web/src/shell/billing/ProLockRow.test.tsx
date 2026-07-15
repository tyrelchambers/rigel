// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProLockRow, ProPill } from "./ProLockRow";

afterEach(cleanup);

test("ProPill renders the PRO label", () => {
  render(<ProPill />);
  expect(screen.getByText("Pro")).toBeInTheDocument();
});

test("ProLockRow shows the pill plus an Upgrade button that fires onUpgrade", () => {
  const onUpgrade = vi.fn();
  render(<ProLockRow onUpgrade={onUpgrade} />);
  expect(screen.getByText("Pro")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /upgrade/i }));
  expect(onUpgrade).toHaveBeenCalledTimes(1);
});

test("ProLockRow renders only the pill when no onUpgrade is given", () => {
  render(<ProLockRow />);
  expect(screen.getByText("Pro")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
