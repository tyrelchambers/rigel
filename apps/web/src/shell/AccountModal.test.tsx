// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

test("email step sends a code and advances", async () => {
  const acc = fakeAccount();
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  expect(screen.getByText("Sign in to Rigel")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("jane@acme.com"), { target: { value: "a@b.co" } });
  fireEvent.click(screen.getByText("Send code"));
  await waitFor(() => expect(acc.requestCode).toHaveBeenCalledWith("a@b.co"));
  await waitFor(() => expect(screen.getByText(/Check your email/)).toBeTruthy());
});

test("code step verifies", async () => {
  const acc = fakeAccount();
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  fireEvent.change(screen.getByPlaceholderText("jane@acme.com"), { target: { value: "a@b.co" } });
  fireEvent.click(screen.getByText("Send code"));
  await waitFor(() => screen.getByText(/Check your email/));
  fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByText("Verify & sign in"));
  await waitFor(() => expect(acc.verifyCode).toHaveBeenCalledWith("a@b.co", "123456"));
});

test("invalid code shows an error", async () => {
  const acc = fakeAccount({ verifyCode: vi.fn().mockResolvedValue({ ok: false, status: 401 }) });
  render(<AccountModal open onOpenChange={vi.fn()} account={acc} />);
  fireEvent.change(screen.getByPlaceholderText("jane@acme.com"), { target: { value: "a@b.co" } });
  fireEvent.click(screen.getByText("Send code"));
  await waitFor(() => screen.getByText(/Check your email/));
  fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "000000" } });
  fireEvent.click(screen.getByText("Verify & sign in"));
  await waitFor(() => expect(screen.getByText(/invalid or expired/i)).toBeTruthy());
});
