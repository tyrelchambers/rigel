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
    requestCode: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    verifyCode: vi.fn().mockResolvedValue({ ok: true, account: { id: "1", email: "a@b.co", name: "Jane" } }),
    signOut: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

test("signed-in shows profile + actions", () => {
  const acc = fakeAccount({ status: "signed-in", account: { id: "1", email: "tychambers3@gmail.com", name: "Tyrel Chambers" }, me: { account: { id: "1", email: "tychambers3@gmail.com", name: "Tyrel Chambers" } } });
  const onOpenChange = vi.fn();
  render(<AccountModal open onOpenChange={onOpenChange} account={acc} />);
  expect(screen.getByText("Tyrel Chambers")).toBeTruthy();
  expect(screen.getByText("tychambers3@gmail.com")).toBeTruthy();
  expect(screen.getByText("Sign out")).toBeTruthy();
  fireEvent.click(screen.getByText("Done"));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  fireEvent.click(screen.getByText("Sign out"));
  expect(acc.signOut).toHaveBeenCalled();
});
