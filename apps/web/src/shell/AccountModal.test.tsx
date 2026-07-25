// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    pendingSignIn: null,
    startSignIn: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
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

test("Feedback opens Featurebase in a new tab", () => {
  const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
  const acc = freeAccount();
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  fireEvent.click(screen.getByRole("button", { name: /feedback/i }));
  expect(openSpy).toHaveBeenCalledWith("https://rigelapp.featurebase.app/", "_blank", "noreferrer");
  openSpy.mockRestore();
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

test("signed-in hides the plan section for a free account", () => {
  const acc = freeAccount();
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  expect(screen.getByText("Jane")).toBeTruthy();
  expect(screen.queryByText("PLAN")).toBeNull();
  expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
  expect(screen.queryByText(/local-only/i)).toBeNull();
});

test("signed-in hides the plan section for a pro account", () => {
  const acc = freeAccount({
    entitlement: { plan: "pro", audits: ["security"], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" },
  });
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  expect(screen.queryByRole("button", { name: /manage billing/i })).toBeNull();
  expect(screen.queryByText(/rigel pro/i)).toBeNull();
});

test("startCheckoutOnOpen auto-enters the embedded checkout view", async () => {
  const acc = freeAccount();
  render(<AccountModal open startCheckoutOnOpen onOpenChange={vi.fn()} account={acc} />);
  expect(await screen.findByTestId("embedded-checkout")).toBeTruthy();
  expect(acc.upgrade).toHaveBeenCalledWith("o1");
});

test("upgrade returning null enters no checkout view", async () => {
  const acc = freeAccount({ upgrade: vi.fn().mockResolvedValue(null) });
  render(<AccountModal open startCheckoutOnOpen onOpenChange={vi.fn()} account={acc} />);
  await act(async () => { await Promise.resolve(); });
  expect(acc.upgrade).toHaveBeenCalledWith("o1");
  expect(screen.queryByTestId("embedded-checkout")).toBeNull();
});

test("onComplete polls refreshBilling until Pro, then closes the checkout view", async () => {
  vi.useFakeTimers();
  try {
    const refreshBilling = vi.fn()
      .mockResolvedValueOnce({ plan: "free", audits: [], cloudConnect: false, agentAutonomy: false, fetchedAt: "t" })
      .mockResolvedValue({ plan: "pro", audits: ["security"], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" });
    const acc = freeAccount({ refreshBilling });
    render(<AccountModal open startCheckoutOnOpen onOpenChange={vi.fn()} account={acc} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("embedded-checkout")).toBeTruthy();

    act(() => { void lastOnComplete?.(); });
    await act(async () => { await Promise.resolve(); });
    expect(refreshBilling).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(refreshBilling).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("embedded-checkout")).toBeNull();
    expect(screen.getByText("Jane")).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(refreshBilling).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("poll exhaustion closes the checkout view without hanging", async () => {
  vi.useFakeTimers();
  try {
    const refreshBilling = vi.fn()
      .mockResolvedValue({ plan: "free", audits: [], cloudConnect: false, agentAutonomy: false, fetchedAt: "t" });
    const acc = freeAccount({ refreshBilling });
    render(<AccountModal open startCheckoutOnOpen onOpenChange={vi.fn()} account={acc} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("embedded-checkout")).toBeTruthy();

    act(() => { void lastOnComplete?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000 * 15); });
    expect(refreshBilling).toHaveBeenCalledTimes(15);
    expect(screen.queryByTestId("embedded-checkout")).toBeNull();
    expect(screen.getByText("Jane")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
