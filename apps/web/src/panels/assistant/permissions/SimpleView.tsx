// SimpleView — one toggle per capability. Pencil frame jCXlB.
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMinus } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { CAPABILITIES, capabilityState, type RbacPolicy, type Risk } from "@rigel/k8s";

export function SimpleView({
  staged,
  onToggleCapability,
  disabled = false,
}: {
  staged: RbacPolicy;
  onToggleCapability: (id: string, on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
      {CAPABILITIES.map((cap) => {
        const state = capabilityState(staged, cap.id);
        return (
          <div key={cap.id} className="flex items-center justify-between gap-4 px-[22px] py-3.5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--fg-primary)]">{cap.label}</span>
                <RiskChip risk={cap.risk} />
              </div>
              <p className="text-xs text-[var(--fg-tertiary)]">{cap.description}</p>
            </div>
            {cap.baseline ? (
              <span className="shrink-0 rounded-full bg-[var(--accent-dim)] px-2.5 py-1 text-2xs font-semibold text-[var(--accent-primary)]">
                Always on
              </span>
            ) : (
              <CapabilityToggle
                state={state}
                disabled={disabled}
                label={cap.label}
                onChange={(on) => onToggleCapability(cap.id, on)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Chip shown next to a non-safe capability's label: amber "Destructive", red "Secrets". */
function RiskChip({ risk }: { risk: Risk }) {
  if (risk === "safe") return null;
  const isSecret = risk === "secret";
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-3xs font-semibold tracking-wide uppercase",
        isSecret ? "bg-red-500/15 text-red-400" : "bg-amber-500/15 text-amber-400",
      )}
    >
      {isSecret ? "Secrets" : "Destructive"}
    </span>
  );
}

/** The row's toggle. On/off render the shared Switch (green when on, gray when
 *  off); "partial" (some but not all of the capability's cells granted) renders
 *  a dash-marked indeterminate pill — clicking it clears the capability. */
function CapabilityToggle({
  state,
  label,
  disabled,
  onChange,
}: {
  state: "on" | "off" | "partial";
  label: string;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  if (state === "partial") {
    return (
      <button
        type="button"
        role="switch"
        aria-checked="mixed"
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(false)}
        className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-[var(--accent-dim)] p-0.5 outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        <FontAwesomeIcon icon={faMinus} className="mx-auto size-3 text-[var(--accent-primary)]" />
      </button>
    );
  }
  return (
    <Switch
      checked={state === "on"}
      disabled={disabled}
      aria-label={label}
      onCheckedChange={(checked) => onChange(checked)}
    />
  );
}
