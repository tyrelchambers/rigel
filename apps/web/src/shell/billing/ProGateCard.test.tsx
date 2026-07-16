// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Cloud } from "lucide-react";
import { ProGateCard } from "./ProGateCard";

afterEach(cleanup);

test("renders title, body, the PRO pill, and fires onUpgrade", () => {
  const onUpgrade = vi.fn();
  render(<ProGateCard icon={Cloud} title="Unlock cloud clusters" body="Connect EKS, GKE, AKS." onUpgrade={onUpgrade} />);
  expect(screen.getByText("Unlock cloud clusters")).toBeInTheDocument();
  expect(screen.getByText("Connect EKS, GKE, AKS.")).toBeInTheDocument();
  expect(screen.getByText("Pro feature")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /upgrade to pro/i }));
  expect(onUpgrade).toHaveBeenCalledTimes(1);
});

test("disables the upgrade button when upgradeDisabled", () => {
  render(<ProGateCard icon={Cloud} title="t" body="b" upgradeDisabled />);
  expect(screen.getByRole("button", { name: /upgrade to pro/i })).toBeDisabled();
});

test("renders the optional see-included link", () => {
  render(<ProGateCard icon={Cloud} title="t" body="b" seeIncluded={{ label: "See what's included", href: "https://x" }} />);
  expect(screen.getByRole("link", { name: /see what's included/i })).toHaveAttribute("href", "https://x");
});
