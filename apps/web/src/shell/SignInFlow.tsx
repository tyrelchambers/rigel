import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEnvelopeCircleCheck, faArrowsRotate, faCheck } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import type { UseAccountResult } from "./useAccount";

interface SignInFlowProps {
  account: UseAccountResult;
  className?: string;
  /** Suppress the "Sign in to Rigel" heading when the host already supplies it
   *  (the onboarding wizard's step header does). */
  hideHeading?: boolean;
}

/** Email in, sign-in link out. All three states are derived from the account,
 *  not local state, so they survive a reload and follow main: signed in, a link
 *  sent and awaiting confirmation, or the form. Signed-in is checked FIRST,
 *  because a successful poll clears pendingSignIn and sets status in the same
 *  refresh, and falling through would show a signed-in user the form again. */
export function SignInFlow({ account, className, hideHeading = false }: SignInFlowProps) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = account.pendingSignIn;
  const signedIn = account.status === "signed-in";

  async function send(address: string) {
    if (!address.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await account.startSignIn(address);
      if (!r.ok) {
        setError(
          r.status === 429
            ? "Too many requests. Try again in a few minutes."
            : "Couldn't send the link. Try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-col gap-5 ${className ?? ""}`}>
      {signedIn ? (
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex size-14 items-center justify-center rounded-full border border-[color-mix(in_oklab,var(--status-running)_32%,transparent)] bg-[color-mix(in_oklab,var(--status-running)_12%,transparent)]">
            <FontAwesomeIcon icon={faCheck} className="size-[24px] text-[var(--status-running)]" />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-base font-semibold text-[var(--fg-primary)]">You&apos;re signed in</h2>
            <p className="text-sm leading-relaxed text-[var(--fg-secondary)]">
              {account.account?.email
                ? `Rigel is signed in as ${account.account.email} on this machine.`
                : "Rigel is signed in on this machine."}
            </p>
          </div>
        </div>
      ) : pending ? (
        // One idea per line: where the link went, the code to match, resend.
        // Everything else said the same thing twice.
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex size-14 items-center justify-center rounded-full border border-[color-mix(in_oklab,var(--accent-primary)_32%,transparent)] bg-[color-mix(in_oklab,var(--accent-primary)_12%,transparent)]">
            <FontAwesomeIcon icon={faEnvelopeCircleCheck} className="size-[24px] text-[var(--accent-primary)]" />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-base font-semibold text-[var(--fg-primary)]">Check your inbox</h2>
            <p className="text-sm leading-relaxed text-[var(--fg-secondary)]">
              We sent a sign-in link to {pending.email}.
            </p>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            {/* Named for screen readers so it is announced as the sign-in code
             *  rather than a bare run of characters. */}
            <output aria-label="Sign-in code" className="font-mono text-3xl font-semibold tracking-widest text-[var(--accent-primary)]">
              {pending.displayCode}
            </output>
            <p className="text-xs text-[var(--fg-secondary)]">Confirm the page shows this code.</p>
          </div>
          {error && (
            <div className="w-full rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void send(pending.email)}>
            <FontAwesomeIcon icon={faArrowsRotate} className="size-3" />
            Send it again
          </Button>
        </div>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void send(email);
          }}
        >
          {!hideHeading && (
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold text-[var(--fg-primary)]">Sign in to Rigel</h2>
              <p className="text-sm text-[var(--fg-secondary)]">
                Enter your email and we&apos;ll send you a sign-in link. Open it whenever you like.
              </p>
            </div>
          )}

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
            Send sign-in link
          </Button>
        </form>
      )}
    </div>
  );
}
