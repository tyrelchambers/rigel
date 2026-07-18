// AlertsTab — alert rules, autonomy mode, and quiet window. Notification
// channels (Signal, Matrix, Discord, Slack) live in Settings > Channels.

import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faBellSlash, faRobot, faCheck, faHand, faCircleInfo, faMoon, faBolt } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAssistantCtx } from "../AssistantContext";
import { AlertsCard } from "../AlertsCard";
import { useEntitlement } from "@/shell/useEntitlement";
import { useAccount } from "@/shell/useAccount";
import { useUpgrade } from "@/shell/UpgradeContext";
import { ProGateCard } from "@/shell/billing/ProGateCard";

// The three autonomy modes, rendered as selectable cards. `value` is the config
// mode the agent reads ("window" is the Quiet-hours schedule).
const MODES = [
  { value: "auto", label: "Auto", icon: faBolt, desc: "Apply safe fixes automatically, no approval needed." },
  { value: "advisory", label: "Advisory", icon: faHand, desc: "Suggest fixes and wait for your approval." },
  { value: "window", label: "Quiet-hours", icon: faMoon, desc: "Auto by day, hold changes overnight." },
] as const;

// Modes where the agent acts on its own — gated behind agentAutonomy. "advisory"
// only suggests, so it stays free.
const AUTONOMOUS_MODES = new Set<string>(["auto", "window"]);

export function AlertsTab() {
  const { d, ns, working, run, setTab } = useAssistantCtx();
  const { payload } = useEntitlement();
  const { orgs } = useAccount();
  const { openUpgrade } = useUpgrade();
  const personalOrgId = orgs.find((o) => o.kind === "personal")?.id;
  const autonomyLocked = !payload?.agentAutonomy;

  const savedWindow = d.quietWindow || "22:00-07:00";
  const [windowText, setWindowText] = useState(savedWindow);

  // Seed from live config when it changes.
  useEffect(() => {
    setWindowText(savedWindow);
  }, [savedWindow]);

  return (
    <div className="space-y-5">
      <AlertsCard />

      <div className="flex flex-col gap-[18px] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[22px]">
        <div className="flex flex-col gap-0.5">
          <p className="text-base font-semibold text-[var(--fg-primary)]">Autonomy</p>
          <p className="text-xs text-[var(--fg-tertiary)]">How the agent acts on safe fixes.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {MODES.map((m) => (
            <ModeCard
              key={m.value}
              icon={m.icon}
              title={m.label}
              desc={m.desc}
              selected={d.autonomyMode === m.value}
              disabled={working || (autonomyLocked && AUTONOMOUS_MODES.has(m.value))}
              onClick={() => run({ action: "setMode", namespace: ns, mode: m.value, window: windowText })}
            />
          ))}
        </div>

        {autonomyLocked && (
          <ProGateCard
            icon={faRobot}
            title="Unlock the in-cluster agent"
            body="Rigel watches your cluster around the clock and applies the fixes you approve. Autonomous remediation, autofix PRs, and scheduled digests."
            upgradeDisabled={!personalOrgId}
            onUpgrade={openUpgrade}
          />
        )}

        {d.autonomyMode === "window" && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
            <span className="text-sm text-[var(--fg-secondary)]">Quiet window</span>
            <input
              value={windowText}
              onChange={(e) => setWindowText(e.target.value)}
              placeholder="22:00-07:00"
              className="w-40 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-primary)] px-3 py-2 font-mono text-xs text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)] focus:border-[var(--accent-primary)]"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={working || windowText === savedWindow}
              onClick={() => setWindowText(savedWindow)}
            >
              Cancel
            </Button>
            <Button
              variant="muted"
              size="sm"
              disabled={working}
              onClick={() => run({ action: "setMode", namespace: ns, mode: "window", window: windowText })}
            >
              Save window
            </Button>
            <p className="w-full text-xs text-[var(--fg-tertiary)]">
              Outside the window (agent timezone), safe fixes are queued for approval instead of
              auto-run.
            </p>
          </div>
        )}

        <div className="h-px w-full bg-[var(--border-subtle)]" />

        <div className="flex items-center gap-1.5 text-xs text-[var(--fg-tertiary)]">
          <FontAwesomeIcon icon={faCircleInfo} className="size-3.5 shrink-0" />
          <span>Notification channels are set up in the</span>
          <button
            type="button"
            onClick={() => setTab("settings")}
            className="font-medium text-[var(--accent-primary)] hover:underline"
          >
            Settings tab.
          </button>
        </div>
      </div>

      {d.silenced.length > 0 && (
        <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[22px]">
          <p className="text-base font-semibold text-[var(--fg-primary)]">
            Silenced ({d.silenced.length})
          </p>
          <div className="mt-3 space-y-2">
            {d.silenced.map((fp) => (
              <div
                key={fp}
                className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2.5"
              >
                <FontAwesomeIcon icon={faBellSlash} className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />
                <span className="truncate font-mono text-xs text-[var(--fg-tertiary)]">{fp}</span>
                <Button
                  variant="muted"
                  size="sm"
                  className="ml-auto"
                  disabled={working}
                  onClick={() => run({ action: "unsilence", namespace: ns, fingerprint: fp })}
                >
                  Unsilence
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One selectable autonomy-mode card: icon tile + title (+ check when active)
 *  over a short description. Accent-tinted when selected. */
function ModeCard({
  icon: Icon,
  title,
  desc,
  selected,
  disabled,
  onClick,
}: {
  icon: IconDefinition;
  title: string;
  desc: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2.5 rounded-md border p-4 text-left transition-colors disabled:opacity-60",
        selected
          ? "border-[var(--accent-primary)] bg-[var(--accent-dim)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-sunken)] hover:border-[var(--border-strong)]",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex size-[26px] shrink-0 items-center justify-center rounded-md",
            selected ? "bg-[var(--accent-dim)]" : "bg-white/5",
          )}
        >
          <FontAwesomeIcon
            icon={Icon}
            className={cn(
              "size-[15px]",
              selected ? "text-[var(--accent-primary)]" : "text-[var(--fg-secondary)]",
            )}
          />
        </span>
        <span className="text-sm font-semibold text-[var(--fg-primary)]">{title}</span>
        {selected && <FontAwesomeIcon icon={faCheck} className="ml-auto size-4 text-[var(--accent-primary)]" />}
      </div>
      <p className="text-xs leading-[1.4] text-[var(--fg-secondary)]">{desc}</p>
    </button>
  );
}
