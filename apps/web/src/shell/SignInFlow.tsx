import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEnvelopeCircleCheck, faShieldCheck, faMobile, faArrowsRotate } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import type { UseAccountResult } from "./useAccount";

interface SignInFlowProps {
  account: UseAccountResult;
  className?: string;
  /** Suppress the wordmark and the "Sign in to Rigel" heading when the host
   *  already supplies that chrome (the onboarding wizard's step header does). */
  hideHeading?: boolean;
}

function Note({ icon, children }: { icon: typeof faShieldCheck; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <FontAwesomeIcon icon={icon} className="size-[13px] text-[var(--fg-tertiary)]" />
      <span className="text-xs text-[var(--fg-secondary)]">{children}</span>
    </div>
  );
}

/** Email in, sign-in link out. The confirmation state is derived from
 *  account.pendingSignIn, not local state, so it survives a reload and clears
 *  itself when main reports the link expired. */
export function SignInFlow({ account, className, hideHeading = false }: SignInFlowProps) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = account.pendingSignIn;

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
      {!hideHeading && (
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-primary" />
          <span className="font-mono text-2xs font-semibold tracking-widest text-[var(--fg-secondary)]">
            RIGEL
          </span>
        </div>
      )}

      {pending ? (
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex size-14 items-center justify-center rounded-full border border-[color-mix(in_oklab,var(--accent-primary)_32%,transparent)] bg-[color-mix(in_oklab,var(--accent-primary)_12%,transparent)]">
            <FontAwesomeIcon icon={faEnvelopeCircleCheck} className="size-[24px] text-[var(--accent-primary)]" />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-base font-semibold text-[var(--fg-primary)]">Check your inbox</h2>
            <p className="text-sm leading-relaxed text-[var(--fg-secondary)]">
              We sent a sign-in link to {pending.email}. Open it on any device and Rigel signs itself
              in, no code to copy back.
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-3 text-xs text-[var(--fg-secondary)]">
            Keep using Rigel in the meantime. Nothing here is blocked.
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

          <div className="flex flex-col gap-2">
            <Note icon={faShieldCheck}>No password and no code to type.</Note>
            <Note icon={faMobile}>The link works on any device, not just this one.</Note>
          </div>

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
