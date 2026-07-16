import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Lock, LogOut, RefreshCw, Sparkles, Zap } from "lucide-react";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SignInFlow } from "./SignInFlow";
import type { UseAccountResult } from "./useAccount";
import type { Org } from "@/lib/desktop";

interface CheckoutSession {
  clientSecret: string;
  publishableKey: string;
}

interface AccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: UseAccountResult;
  startCheckoutOnOpen?: boolean;
}

const PRO_FEATURES = ["Audits", "Cloud connect", "Autonomous agent"];

function capitalize(role: string) {
  return role[0].toUpperCase() + role.slice(1);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function OrgRow({ org }: { org: Org }) {
  const isPersonal = org.kind === "personal";
  const name = isPersonal ? "Personal" : org.name;
  const sublabel = isPersonal ? "Just you" : "Team";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3.5 py-2.5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent-dim)] font-heading text-base font-bold text-[var(--accent-soft)]">
        {name.charAt(0).toUpperCase()}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-[var(--fg-primary)]">{name}</span>
        <span className="truncate text-xs text-[var(--fg-tertiary)]">{sublabel}</span>
      </div>
      <span className="shrink-0 rounded-full bg-[var(--accent-dim)] px-2.5 py-0.5 text-2xs font-semibold text-[var(--accent-soft)]">
        {capitalize(org.role)}
      </span>
    </div>
  );
}

function CheckoutView({
  session,
  onBack,
  onComplete,
}: {
  session: CheckoutSession;
  onBack: () => void;
  onComplete: () => void;
}) {
  const stripePromise = useMemo(
    () => loadStripe(session.publishableKey),
    [session.publishableKey],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="text-[var(--fg-secondary)]" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          Back
        </Button>
        <span className="font-heading text-base font-semibold text-[var(--fg-primary)]">
          Upgrade to Pro
        </span>
      </div>
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2">
        <EmbeddedCheckoutProvider
          stripe={stripePromise}
          options={{ clientSecret: session.clientSecret, onComplete }}
        >
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
    </div>
  );
}

export function AccountModal({ open, onOpenChange, account, startCheckoutOnOpen }: AccountModalProps) {
  const { status } = account;
  const [checkout, setCheckout] = useState<CheckoutSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const personalOrgId = account.orgs.find((o) => o.kind === "personal")?.id;

  const startCheckout = useCallback(async () => {
    if (!personalOrgId || busy) return;
    setBusy(true);
    setError(null);
    const r = await account.upgrade(personalOrgId);
    setBusy(false);
    if (r) setCheckout(r);
    else setError("Couldn't start checkout — try again");
  }, [personalOrgId, busy, account]);

  const firedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      firedRef.current = false;
      return;
    }
    if (startCheckoutOnOpen && status === "signed-in" && personalOrgId && !checkout && !firedRef.current) {
      firedRef.current = true;
      void startCheckout();
    }
  }, [open, startCheckoutOnOpen, status, personalOrgId, checkout, startCheckout]);

  const pollRef = useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => () => { if (pollRef.current) pollRef.current.cancelled = true; }, []);
  useEffect(() => { if (!open && pollRef.current) pollRef.current.cancelled = true; }, [open]);

  async function handleComplete() {
    if (pollRef.current) pollRef.current.cancelled = true;
    const token = { cancelled: false };
    pollRef.current = token;
    for (let i = 0; i < 10; i++) {
      const e = await account.refreshBilling();
      if (token.cancelled) return;
      if (e?.plan === "pro") break;
      await new Promise((r) => setTimeout(r, 2000));
      if (token.cancelled) return;
    }
    if (!token.cancelled) setCheckout(null);
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
    const name =
      account.account?.name ||
      (account.account?.email ? account.account.email.split("@")[0] : "Signed in");
    const isPro = account.entitlement?.plan === "pro";

    if (checkout) {
      return (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="max-w-[30rem]">
            <DialogHeader>
              <DialogTitle>Account</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <CheckoutView
                session={checkout}
                onBack={() => setCheckout(null)}
                onComplete={handleComplete}
              />
            </DialogBody>
          </DialogContent>
        </Dialog>
      );
    }

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[30rem]">
          <DialogHeader>
            <DialogTitle>Account</DialogTitle>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-5">
            <div className="flex items-center gap-3.5">
              <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-hover)] text-lg font-bold text-white">
                {initials(name)}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-heading text-base font-semibold text-[var(--fg-primary)]">
                  {name}
                </span>
                <span className="truncate font-mono text-xs text-[var(--fg-tertiary)]">
                  {account.account?.email}
                </span>
              </div>
            </div>

            <div className="h-px w-full bg-[var(--border-subtle)]" />

            {account.orgs.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <span className="font-mono text-3xs tracking-wide text-[var(--fg-tertiary)]">
                  ORGANIZATIONS
                </span>
                <div className="flex flex-col gap-2">
                  {account.orgs.map((org) => (
                    <OrgRow key={org.id} org={org} />
                  ))}
                </div>
              </div>
            )}

            <div className="h-px w-full bg-[var(--border-subtle)]" />

            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-3xs tracking-wide text-[var(--fg-tertiary)]">
                  PLAN
                </span>
                <button
                  type="button"
                  aria-label="Refresh plan"
                  onClick={() => account.refreshBilling()}
                  className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-3xs text-[var(--fg-tertiary)] transition-colors hover:bg-white/[0.05] hover:text-[var(--fg-secondary)]"
                >
                  <RefreshCw className="size-3" />
                  Refresh
                </button>
              </div>

              <div className="flex flex-col gap-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3.5">
                <div className="flex items-center gap-3">
                  <div className="flex size-[38px] shrink-0 items-center justify-center rounded-[9px] bg-[var(--accent-dim)]">
                    {isPro ? (
                      <Zap className="size-[19px] text-[var(--accent-primary)]" />
                    ) : (
                      <Sparkles className="size-[19px] text-[var(--accent-primary)]" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-heading text-base font-semibold text-[var(--fg-primary)]">
                      {isPro ? "Rigel Pro" : "Free"}
                    </span>
                    <span className="truncate text-xs text-[var(--fg-tertiary)]">
                      {isPro
                        ? account.orgs.length === 1
                          ? "1 seat"
                          : `${account.orgs.length} orgs`
                        : "Local-only. You're on the free plan."}
                    </span>
                  </div>
                  {isPro ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={!personalOrgId}
                      onClick={() => personalOrgId && account.manageBilling(personalOrgId)}
                    >
                      Manage billing
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="shrink-0"
                      disabled={!personalOrgId || busy}
                      onClick={startCheckout}
                    >
                      <Zap className="size-3.5" />
                      {busy ? "Starting…" : "Upgrade to Pro"}
                    </Button>
                  )}
                </div>

                {error && (
                  <span className="text-xs text-[var(--destructive)]">{error}</span>
                )}

                {!isPro && (
                  <>
                    <div className="h-px w-full bg-white/[0.04]" />
                    <div className="flex flex-col gap-2.5">
                      <span className="font-mono text-3xs tracking-wide text-[var(--fg-tertiary)]">
                        PRO UNLOCKS
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {PRO_FEATURES.map((feat) => (
                          <div
                            key={feat}
                            className="flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-white/[0.03] px-2 py-1"
                          >
                            <Lock className="size-3 text-[var(--fg-tertiary)]" />
                            <span className="text-xs text-[var(--fg-secondary)]">{feat}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </DialogBody>

          <DialogFooter className="sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              className="text-[var(--fg-secondary)]"
              onClick={() => account.signOut()}
            >
              <LogOut className="size-3.5" />
              Sign out
            </Button>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
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
          <SignInFlow account={account} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
