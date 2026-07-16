// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LoginGate } from "./LoginGate";
import type { UseAccountResult } from "./useAccount";

afterEach(cleanup);

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
    upgrade: vi.fn().mockResolvedValue({ ok: true }),
    manageBilling: vi.fn().mockResolvedValue({ ok: true }),
    refreshBilling: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

test("renders the sign-in flow full-screen", () => {
  render(<LoginGate account={fakeAccount()} />);
  expect(screen.getByText("Sign in to Rigel")).toBeTruthy();
});
