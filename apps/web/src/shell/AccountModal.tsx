import { LogOut, RefreshCw, User } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SignInFlow } from "./SignInFlow";
import type { UseAccountResult } from "./useAccount";
import type { Org } from "@/lib/desktop";

interface AccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: UseAccountResult;
}

function capitalize(role: string) {
  return role[0].toUpperCase() + role.slice(1);
}

function OrgRow({ org }: { org: Org }) {
  const isPersonal = org.kind === "personal";
  const name = isPersonal ? "Personal" : org.name;
  const sublabel = isPersonal ? "Just you" : "Team";
  const initial = name.charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div
        className={`flex size-[34px] shrink-0 items-center justify-center rounded-[9px] text-sm font-semibold ${
          isPersonal ? "bg-[var(--accent-dim)] text-[var(--accent-primary)]" : "bg-white/[0.06] text-[var(--fg-secondary)]"
        }`}
      >
        {initial}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-[var(--fg-primary)]">{name}</span>
        <span className="truncate text-xs text-[var(--fg-secondary)]">{sublabel}</span>
      </div>
      <span className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-2xs font-medium text-[var(--fg-secondary)]">
        {capitalize(org.role)}
      </span>
    </div>
  );
}

export function AccountModal({ open, onOpenChange, account }: AccountModalProps) {
  const { status } = account;

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
    const personalOrgId = account.orgs.find((o) => o.kind === "personal")?.id;
    const isPro = account.entitlement?.plan === "pro";
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

              {account.orgs.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-3xs font-mono tracking-wide text-[var(--fg-tertiary)]">
                    ORGANIZATIONS
                  </span>
                  <div className="flex flex-col gap-1 rounded-lg border border-[var(--border-subtle)] bg-white/[0.02] p-1">
                    {account.orgs.map((org) => (
                      <OrgRow key={org.id} org={org} />
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-lg border border-[var(--border-subtle)] bg-white/[0.02] p-3">
                <div className="flex items-center justify-between">
                  <span className="text-3xs font-mono tracking-wide text-[var(--fg-tertiary)]">PLAN</span>
                  <button
                    type="button"
                    aria-label="Refresh plan"
                    onClick={() => account.refreshBilling()}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs text-[var(--fg-tertiary)] transition-colors hover:bg-white/[0.05] hover:text-[var(--fg-secondary)]"
                  >
                    <RefreshCw className="size-3" />
                    Refresh
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-sm text-[var(--fg-primary)]">{isPro ? "Rigel Pro" : "Free"}</span>
                  {isPro ? (
                    <Button size="sm" variant="outline" onClick={() => personalOrgId && account.manageBilling(personalOrgId)}>
                      Manage billing
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => personalOrgId && account.upgrade(personalOrgId)}>
                      Upgrade
                    </Button>
                  )}
                </div>
                {isPro && (
                  <span className="mt-1 block text-xs text-[var(--fg-tertiary)]">
                    {account.orgs.filter((o) => o.role !== undefined).length === 1 ? "1 seat" : `${account.orgs.length} orgs`}
                  </span>
                )}
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
          <SignInFlow account={account} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
