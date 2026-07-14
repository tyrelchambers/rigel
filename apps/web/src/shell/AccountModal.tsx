import { useEffect, useState } from "react";
import { LogOut, User } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { UseAccountResult } from "./useAccount";

interface AccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: UseAccountResult;
}

type Step = "email" | "code";

function CodeBoxes({ code, invalid }: { code: string; invalid: boolean }) {
  return (
    <div className="flex gap-2">
      {Array.from({ length: 6 }).map((_, i) => {
        const filled = i < code.length;
        return (
          <div
            key={i}
            className={`flex h-11 flex-1 items-center justify-center rounded-lg border bg-[var(--surface-sunken)] font-mono text-base text-[var(--fg-primary)] ${
              invalid
                ? "border-destructive"
                : filled
                  ? "border-primary"
                  : "border-[var(--border-subtle)]"
            }`}
          >
            {code[i] ?? ""}
          </div>
        );
      })}
    </div>
  );
}

export function AccountModal({ open, onOpenChange, account }: AccountModalProps) {
  const { status } = account;
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setStep("email");
      setEmail("");
      setCode("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (status === "signed-in") {
      setStep("email");
      setCode("");
      setError(null);
      setBusy(false);
    }
  }, [status]);

  async function handleSendCode() {
    if (!email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await account.requestCode(email);
      if (r.ok) {
        setStep("code");
      } else if (r.status === 429) {
        setError("Too many requests. Try again in a few minutes.");
      } else {
        setError("Couldn't send a code. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    setBusy(true);
    try {
      const r = await account.verifyCode(email, code);
      if (!r.ok) {
        if (r.status === 401) {
          setError("That code is invalid or expired. Request a new one.");
        } else if (r.status === 429) {
          setError("Too many attempts. Wait a moment and try again.");
        } else {
          setError("Couldn't verify that code. Try again.");
        }
      } else {
        setError(null);
      }
    } finally {
      setBusy(false);
    }
  }

  if (status === "loading") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Account</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex items-center justify-center py-10 text-sm text-[var(--fg-secondary)]">
              &hellip;
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  if (status === "signed-in") {
    const name = account.account?.name || (account.account?.email ? account.account.email.split("@")[0] : "Signed in");
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Account</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-5">
              <div className="flex items-center gap-3.5">
                <div className="flex size-14 shrink-0 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--accent-dim)]">
                  <User size={26} className="text-primary" />
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-semibold text-[var(--fg-primary)]">{name}</span>
                  <span className="truncate font-mono text-xs text-[var(--fg-secondary)]">
                    {account.account?.email}
                  </span>
                </div>
              </div>

              <div className="h-px w-full bg-[var(--border-subtle)]" />

              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--fg-secondary)]">Plan</span>
                <span className="rounded-full border border-[var(--border-subtle)] bg-white/[0.04] px-2.5 py-1 text-2xs font-medium text-[var(--fg-primary)]">
                  Free
                </span>
              </div>

              <div className="mt-1 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => account.signOut()}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-[var(--fg-secondary)] transition-colors hover:bg-white/[0.05] hover:text-[var(--fg-primary)]"
                >
                  <LogOut size={14} />
                  Sign out
                </button>
                <Button onClick={() => onOpenChange(false)}>Done</Button>
              </div>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-primary" />
              <span className="font-mono text-2xs font-semibold tracking-widest text-[var(--fg-secondary)]">
                RIGEL
              </span>
            </div>

            {step === "email" ? (
              <>
                <div className="flex flex-col gap-1">
                  <h2 className="text-base font-semibold text-[var(--fg-primary)]">Sign in to Rigel</h2>
                  <p className="text-sm text-[var(--fg-secondary)]">
                    Enter your email and we&apos;ll send you a 6-digit sign-in code.
                  </p>
                </div>

                <input
                  type="email"
                  placeholder="jane@acme.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2.5 text-sm text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)] focus:border-primary/50"
                />

                {error && (
                  <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
                )}

                <Button className="w-full" disabled={busy} onClick={handleSendCode}>
                  Send code
                </Button>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <h2 className="text-base font-semibold text-[var(--fg-primary)]">Check your email</h2>
                  <p className="text-sm text-[var(--fg-secondary)]">
                    We sent a 6-digit code to {email}. It expires in 10 minutes.
                  </p>
                </div>

                <div className="relative">
                  <CodeBoxes code={code} invalid={!!error} />
                  <input
                    aria-label="Verification code"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="absolute inset-0 h-full w-full opacity-0"
                  />
                </div>

                {error && (
                  <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
                )}

                <Button className="w-full" disabled={busy || code.length < 6} onClick={handleVerify}>
                  Verify &amp; sign in
                </Button>

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => account.requestCode(email)}
                    className="text-xs font-medium text-[var(--fg-secondary)] transition-colors hover:text-[var(--fg-primary)]"
                  >
                    Resend code
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStep("email");
                      setCode("");
                      setError(null);
                    }}
                    className="text-xs font-medium text-[var(--fg-secondary)] transition-colors hover:text-[var(--fg-primary)]"
                  >
                    Use a different email
                  </button>
                </div>
              </>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
