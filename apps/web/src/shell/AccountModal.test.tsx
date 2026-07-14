// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccountModal } from "./AccountModal";
import type { UseAccountResult } from "./useAccount";

afterEach(cleanup);

function fakeAccount(over: Partial<UseAccountResult> = {}): UseAccountResult {
  return {
    status: "signed-out",
    account: null,
    me: null,
    orgs: [],
    requestCode: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    verifyCode: vi.fn().mockResolvedValue({ ok: true, account: { id: "1", email: "a@b.co", name: "Jane" } }),
    signOut: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
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
