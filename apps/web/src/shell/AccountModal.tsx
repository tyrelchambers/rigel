import { LogOut, User } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SignInFlow } from "./SignInFlow";
import type { UseAccountResult } from "./useAccount";

interface AccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: UseAccountResult;
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
          <SignInFlow account={account} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
