// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { EntitlementPayload } from "@/lib/desktop";

const entitlement = vi.hoisted(() => ({ payload: null as EntitlementPayload | null }));
const upgrade = vi.hoisted(() => ({ openUpgrade: vi.fn() }));
const account = vi.hoisted(() => ({
  orgs: [{ id: "o1", kind: "personal", name: "Jane", role: "owner" }] as {
    id: string;
    kind: "personal" | "team";
    name: string;
    role: "owner" | "admin" | "member";
  }[],
}));
vi.mock("@/shell/useEntitlement", () => ({ useEntitlement: () => ({ payload: entitlement.payload, upgrade: vi.fn() }) }));
vi.mock("@/shell/UpgradeContext", () => ({ useUpgrade: () => upgrade }));
vi.mock("@/shell/useAccount", () => ({ useAccount: () => account }));

import { UpgradeCard } from "./UpgradeCard";

const free: EntitlementPayload = {
  plan: "free", audits: [], cloudConnect: false, agentAutonomy: false, fetchedAt: "2026-07-24T00:00:00Z",
};

describe("UpgradeCard", () => {
  beforeEach(() => {
    localStorage.clear();
    entitlement.payload = free;
    upgrade.openUpgrade = vi.fn();
    account.orgs = [{ id: "o1", kind: "personal", name: "Jane", role: "owner" }];
  });

  it("renders for a free plan", () => {
    render(<UpgradeCard />);
    expect(screen.getByText(/on the free plan/i)).toBeInTheDocument();
  });

  it("renders nothing on pro", () => {
    entitlement.payload = { ...free, plan: "pro" };
    const { container } = render(<UpgradeCard />);
    expect(container).toBeEmptyDOMElement();
    expect(container.querySelector(".ov-row")).toBeNull();
  });

  it("renders nothing before entitlements resolve", () => {
    entitlement.payload = null;
    const { container } = render(<UpgradeCard />);
    expect(container).toBeEmptyDOMElement();
    expect(container.querySelector(".ov-row")).toBeNull();
  });

  it("stays dismissed across remounts", () => {
    const first = render(<UpgradeCard />);
    fireEvent.click(screen.getByRole("button", { name: /maybe later/i }));
    expect(first.container).toBeEmptyDOMElement();

    first.unmount();
    const second = render(<UpgradeCard />);
    expect(second.container).toBeEmptyDOMElement();
  });

  it("disables the upgrade button when there is no personal org", () => {
    account.orgs = [{ id: "t1", kind: "team", name: "Acme", role: "owner" }];
    render(<UpgradeCard />);
    expect(screen.getByRole("button", { name: /upgrade to pro/i })).toBeDisabled();
  });

  it("calls openUpgrade when the upgrade button is clicked", () => {
    render(<UpgradeCard />);
    fireEvent.click(screen.getByRole("button", { name: /upgrade to pro/i }));
    expect(upgrade.openUpgrade).toHaveBeenCalledTimes(1);
  });
});
