import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { UseAccountResult } from "./useAccount";

interface SignInFlowProps {
  account: UseAccountResult;
  className?: string;
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

export function SignInFlow({ account, className }: SignInFlowProps) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className={`flex flex-col gap-5 ${className ?? ""}`}>
      <div className="flex items-center gap-2">
        <span className="size-1.5 rounded-full bg-primary" />
        <span className="font-mono text-2xs font-semibold tracking-widest text-[var(--fg-secondary)]">
          RIGEL
        </span>
      </div>

      {step === "email" ? (
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            handleSendCode();
          }}
        >
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold text-[var(--fg-primary)]">Sign in to Rigel</h2>
            <p className="text-sm text-[var(--fg-secondary)]">
              Enter your email and we&apos;ll send you a 6-digit sign-in code.
            </p>
          </div>

          <input
            type="email"
            placeholder="jane@acme.com"
            aria-label="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2.5 text-sm text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)] focus:border-primary/50"
          />

          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
          )}

          <Button type="submit" className="w-full" disabled={busy}>
            Send code
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            handleVerify();
          }}
        >
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

          <Button type="submit" className="w-full" disabled={busy || code.length < 6}>
            Verify &amp; sign in
          </Button>

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={handleSendCode}
              disabled={busy}
              className="text-xs font-medium text-[var(--fg-secondary)] transition-colors hover:text-[var(--fg-primary)] disabled:cursor-not-allowed disabled:opacity-50"
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
        </form>
      )}
    </div>
  );
}
