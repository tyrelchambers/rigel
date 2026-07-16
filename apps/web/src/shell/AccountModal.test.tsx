// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountModal } from "./AccountModal";
import type { UseAccountResult } from "./useAccount";

let lastOnComplete: (() => void) | undefined;

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: ({
    children,
    options,
  }: {
    children: React.ReactNode;
    options: { onComplete?: () => void };
  }) => {
    lastOnComplete = options.onComplete;
    return <div>{children}</div>;
  },
  EmbeddedCheckout: () => <div data-testid="embedded-checkout">checkout</div>,
}));

afterEach(() => {
  cleanup();
  lastOnComplete = undefined;
});

function fakeAccount(over: Partial<UseAccountResult> = {}): UseAccountResult {
  return {
    status: "signed-out",
    account: null,
    me: null,
    orgs: [],
    entitlement: null,
    requestCode: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    verifyCode: vi.fn().mockResolvedValue({ ok: true, account: { id: "1", email: "a@b.co", name: "Jane" } }),
    signOut: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    upgrade: vi.fn().mockResolvedValue({ clientSecret: "cs_test", publishableKey: "pk_test" }),
    manageBilling: vi.fn().mockResolvedValue({ ok: true }),
    refreshBilling: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

test("signed-in shows profile + actions", () => {
  const acc = fakeAccount({
    status: "signed-in",
    account: { id: "1", email: "tychambers3@gmail.com", name: "Tyrel Chambers" },
    me: { account: { id: "1", email: "tychambers3@gmail.com", name: "Tyrel Chambers" } },
    orgs: [
      { id: "o1", kind: "personal", name: "Tyrel Chambers", role: "owner" },
      { id: "o2", kind: "team", name: "Acme", role: "member" },
    ],
  });
  const onOpenChange = vi.fn();
  render(<AccountModal open onOpenChange={onOpenChange} account={acc} />);
  expect(screen.getByText("Tyrel Chambers")).toBeTruthy();
  expect(screen.getByText("tychambers3@gmail.com")).toBeTruthy();
  expect(screen.getByText("Sign out")).toBeTruthy();
  expect(screen.getByText("Personal")).toBeTruthy();
  expect(screen.getByText("Owner")).toBeTruthy();
  expect(screen.getByText("Acme")).toBeTruthy();
  expect(screen.getByText("Member")).toBeTruthy();
  fireEvent.click(screen.getByText("Done"));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  fireEvent.click(screen.getByText("Sign out"));
  expect(acc.signOut).toHaveBeenCalled();
});

test("free plan shows Upgrade, calls upgrade(personalOrgId) on click", () => {
  const acc = fakeAccount({
    status: "signed-in",
    account: { id: "1", email: "a@b.co", name: "Jane" },
    orgs: [{ id: "o1", kind: "personal", name: "Personal", role: "owner" }],
    entitlement: { plan: "free", audits: [], cloudConnect: false, agentAutonomy: false, fetchedAt: "t" },
  });
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  const btn = screen.getByRole("button", { name: /upgrade/i });
  fireEvent.click(btn);
  expect(acc.upgrade).toHaveBeenCalledWith("o1");
});

function freeAccount(over: Partial<UseAccountResult> = {}) {
  return fakeAccount({
    status: "signed-in",
    account: { id: "1", email: "a@b.co", name: "Jane" },
    orgs: [{ id: "o1", kind: "personal", name: "Personal", role: "owner" }],
    entitlement: { plan: "free", audits: [], cloudConnect: false, agentAutonomy: false, fetchedAt: "t" },
    ...over,
  });
}

test("clicking Upgrade enters the embedded checkout view", async () => {
  const acc = freeAccount();
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  fireEvent.click(screen.getByRole("button", { name: /upgrade/i }));
  expect(await screen.findByTestId("embedded-checkout")).toBeTruthy();
});

test("onComplete refetches billing and returns to the account view", async () => {
  const acc = freeAccount();
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  fireEvent.click(screen.getByRole("button", { name: /upgrade/i }));
  await screen.findByTestId("embedded-checkout");
  act(() => lastOnComplete?.());
  expect(acc.refreshBilling).toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByTestId("embedded-checkout")).toBeNull());
  expect(screen.getByRole("button", { name: /upgrade/i })).toBeTruthy();
});

test("upgrade returning null shows an inline error, no checkout view", async () => {
  const acc = freeAccount({ upgrade: vi.fn().mockResolvedValue(null) });
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  fireEvent.click(screen.getByRole("button", { name: /upgrade/i }));
  expect(await screen.findByText(/couldn't start checkout/i)).toBeTruthy();
  expect(screen.queryByTestId("embedded-checkout")).toBeNull();
});

test("pro plan shows Manage billing + the seat count", () => {
  const acc = fakeAccount({
    status: "signed-in",
    account: { id: "1", email: "a@b.co", name: "Jane" },
    orgs: [{ id: "o1", kind: "personal", name: "Personal", role: "owner" }],
    entitlement: { plan: "pro", audits: ["security"], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" },
  });
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  expect(screen.getByText(/rigel pro/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: /manage billing/i })).toBeTruthy();
  expect(screen.getByText(/1 seat/i)).toBeTruthy();
});
