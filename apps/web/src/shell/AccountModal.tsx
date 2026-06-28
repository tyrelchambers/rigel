import { User, LogOut } from "lucide-react";
import { Modal } from "@/components/ui/modal";

interface AccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name?: string;
  email?: string;
  /** Display-only for now; not gating anything (canConnect stays allow-all). */
  plan?: string;
}

const HAIRLINE = "rgba(255,255,255,0.07)";

/** Basic account panel: avatar + name + email, a plan badge, and a (cosmetic) Sign out. */
export function AccountModal({ open, onOpenChange, name, email, plan = "Free" }: AccountModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Account" maxWidth="!max-w-md">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3.5">
          <div
            className="flex shrink-0 items-center justify-center rounded-full"
            style={{ width: 56, height: 56, background: "var(--accent-dim)", border: "1px solid var(--border-subtle)" }}
          >
            <User size={26} style={{ color: "var(--accent-primary)" }} />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-semibold" style={{ color: "var(--fg-primary)" }}>
              {name || "Your account"}
            </span>
            <span className="truncate font-mono text-xs" style={{ color: "var(--fg-secondary)" }}>
              {email || "Details not available yet"}
            </span>
          </div>
        </div>

        <div style={{ height: 1, background: HAIRLINE }} />

        <div className="flex items-center justify-between">
          <span className="text-xs font-medium" style={{ color: "var(--fg-secondary)" }}>Plan</span>
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-medium"
            style={{ color: "var(--fg-primary)", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            {plan}
          </span>
        </div>

        <div className="mt-1 flex items-center justify-between">
          <button
            type="button"
            title="Sign out (coming soon)"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors hover:bg-white/[0.05]"
            style={{ color: "var(--fg-secondary)" }}
          >
            <LogOut size={14} />
            Sign out
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-lg px-4 py-2 text-xs font-semibold transition-opacity hover:opacity-90"
            style={{ background: "var(--accent-primary)", color: "var(--accent-foreground)" }}
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
