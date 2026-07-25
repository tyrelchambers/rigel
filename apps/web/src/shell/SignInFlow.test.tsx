// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SignInFlow } from "./SignInFlow";
import type { UseAccountResult } from "./useAccount";

function account(over: Partial<UseAccountResult> = {}): UseAccountResult {
  return {
    status: "signed-out",
    account: null,
    me: null,
    orgs: [],
    entitlement: null,
    pendingSignIn: null,
    startSignIn: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    signOut: vi.fn(),
    refresh: vi.fn(),
    upgrade: vi.fn(),
    manageBilling: vi.fn(),
    refreshBilling: vi.fn(),
    ...over,
  } as UseAccountResult;
}

describe("SignInFlow", () => {
  it("submits the email and never asks for a code", async () => {
    const acct = account();
    render(<SignInFlow account={acct} />);

    expect(screen.queryByLabelText(/verification code/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "jane@acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send.*link/i }));

    await waitFor(() => expect(acct.startSignIn).toHaveBeenCalledWith("jane@acme.com"));
  });

  it("rejects an address with no @ before calling the bridge", async () => {
    const acct = account();
    render(<SignInFlow account={acct} />);
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /send.*link/i }));

    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    expect(acct.startSignIn).not.toHaveBeenCalled();
  });

  it("shows the inbox panel with the address once a sign-in is pending", () => {
    render(<SignInFlow account={account({ pendingSignIn: { email: "jane@acme.com", expiresAt: Date.now() + 1000 } })} />);
    expect(screen.getByText(/check your inbox/i)).toBeInTheDocument();
    expect(screen.getByText(/jane@acme\.com/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
  });

  it("resends from the inbox panel", async () => {
    const acct = account({ pendingSignIn: { email: "jane@acme.com", expiresAt: Date.now() + 1000 } });
    render(<SignInFlow account={acct} />);
    fireEvent.click(screen.getByRole("button", { name: /send it again/i }));
    await waitFor(() => expect(acct.startSignIn).toHaveBeenCalledWith("jane@acme.com"));
  });

  it("surfaces a rate-limit failure", async () => {
    const acct = account({ startSignIn: vi.fn().mockResolvedValue({ ok: false, status: 429 }) });
    render(<SignInFlow account={acct} />);
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "jane@acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send.*link/i }));
    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
  });

  it("drops the wordmark and heading when the host supplies its own chrome", () => {
    render(<SignInFlow account={account()} hideHeading />);
    expect(screen.queryByText("RIGEL")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /sign in to rigel/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
  });
});
