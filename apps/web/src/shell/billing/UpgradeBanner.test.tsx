// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { UpgradeBanner } from "./UpgradeBanner";

afterEach(cleanup);

test("renders the free-plan headline and fires onUpgrade", () => {
  const onUpgrade = vi.fn();
  render(<UpgradeBanner onUpgrade={onUpgrade} onDismiss={vi.fn()} />);
  expect(screen.getByText(/you're on the free plan/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /upgrade to pro/i }));
  expect(onUpgrade).toHaveBeenCalledTimes(1);
});

test("fires onDismiss from Maybe later", () => {
  const onDismiss = vi.fn();
  render(<UpgradeBanner onUpgrade={vi.fn()} onDismiss={onDismiss} />);
  fireEvent.click(screen.getByRole("button", { name: /maybe later/i }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("omits Maybe later when no onDismiss is given", () => {
  render(<UpgradeBanner onUpgrade={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /maybe later/i })).not.toBeInTheDocument();
});
