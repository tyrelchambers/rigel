// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SignInFlow } from "./SignInFlow";
import type { UseAccountResult } from "./useAccount";
import type { Account } from "@/lib/desktop";

const jane: Account = { id: "a1", email: "jane@acme.com", name: null };

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
    render(<SignInFlow account={account({ pendingSignIn: { email: "jane@acme.com", expiresAt: Date.now() + 1000, displayCode: "4K7Q-9WXZ" } })} />);
    expect(screen.getByText(/check your inbox/i)).toBeInTheDocument();
    expect(screen.getByText(/jane@acme\.com/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
  });

  // The display code is the login-CSRF guard: the confirm page asks the human to
  // match it, so an attacker who started the sign-in cannot borrow the victim's
  // click. It has to be the code THIS pending record carries, not a placeholder.
  it("shows the pending record's own display code for the human to match", () => {
    render(<SignInFlow account={account({ pendingSignIn: { email: "jane@acme.com", expiresAt: Date.now() + 1000, displayCode: "ZZZZ-1111" } })} />);
    expect(screen.getByLabelText(/sign-in code/i)).toHaveTextContent("ZZZZ-1111");
    expect(screen.getByText(/check this code/i)).toBeInTheDocument();
    expect(screen.getByText(/same code/i)).toBeInTheDocument();
  });

  it("no longer claims there is no code to copy back", () => {
    render(<SignInFlow account={account({ pendingSignIn: { email: "jane@acme.com", expiresAt: Date.now() + 1000, displayCode: "ZZZZ-1111" } })} />);
    expect(screen.getByText(/check your inbox/i)).toBeInTheDocument();
    expect(document.body.textContent).toContain("ZZZZ-1111");
    expect(document.body.textContent).not.toMatch(/no code to copy back/i);
  });

  it("keeps the code out of the email form, where there is nothing to match", () => {
    render(<SignInFlow account={account()} />);
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/sign-in code/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b[0-9A-Z]{4}-[0-9A-Z]{4}\b/);
  });

  it("keeps the code out of the signed-in state even with a stale pending record", () => {
    render(
      <SignInFlow
        account={account({
          status: "signed-in",
          account: jane,
          pendingSignIn: { email: "jane@acme.com", expiresAt: Date.now() + 1000, displayCode: "ZZZZ-1111" },
        })}
      />,
    );
    expect(screen.getByText(/you're signed in/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/sign-in code/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("ZZZZ-1111");
  });

  it("resends from the inbox panel", async () => {
    const acct = account({ pendingSignIn: { email: "jane@acme.com", expiresAt: Date.now() + 1000, displayCode: "4K7Q-9WXZ" } });
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

  // A successful poll clears pendingSignIn and flips status to "signed-in" in the
  // same refresh. Without a signed-in branch the flow would fall back to the
  // email form and show a just-signed-in user "Sign in to Rigel" again.
  it("confirms the signed-in account instead of falling back to the form", () => {
    render(<SignInFlow account={account({ status: "signed-in", account: jane })} />);
    expect(screen.getByText(/you're signed in/i)).toBeInTheDocument();
    expect(screen.getByText(/jane@acme\.com/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/check your inbox/i)).not.toBeInTheDocument();
  });

  it("prefers the signed-in state over a stale pending record", () => {
    render(
      <SignInFlow
        account={account({
          status: "signed-in",
          account: jane,
          pendingSignIn: { email: "jane@acme.com", expiresAt: Date.now() + 1000, displayCode: "4K7Q-9WXZ" },
        })}
      />,
    );
    expect(screen.getByText(/you're signed in/i)).toBeInTheDocument();
    expect(screen.queryByText(/check your inbox/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send it again/i })).not.toBeInTheDocument();
  });

  it("confirms sign-in without an address when the account has no email", () => {
    render(<SignInFlow account={account({ status: "signed-in", account: null })} />);
    expect(screen.getByText(/you're signed in/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("undefined");
  });

  it("drops the wordmark and heading when the host supplies its own chrome", () => {
    render(<SignInFlow account={account()} hideHeading />);
    expect(screen.queryByText("RIGEL")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /sign in to rigel/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
  });
});
