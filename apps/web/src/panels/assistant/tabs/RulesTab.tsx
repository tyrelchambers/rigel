// RulesTab — alert rules, autonomy mode, quiet window, and notify webhook.
// Built to Pencil frame "Assistant — Rules (improved)".

import { useEffect, useState } from "react";
import { BellOff, Check, Hand, Info, Link as LinkIcon, Moon, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAssistantCtx } from "../AssistantContext";
import { AlertsCard } from "../AlertsCard";

// The three autonomy modes, rendered as selectable cards. `value` is the config
// mode the agent reads ("window" is the Quiet-hours schedule).
const MODES = [
  { value: "auto", label: "Auto", icon: Zap, desc: "Apply safe fixes automatically, no approval needed." },
  { value: "advisory", label: "Advisory", icon: Hand, desc: "Suggest fixes and wait for your approval." },
  { value: "window", label: "Quiet-hours", icon: Moon, desc: "Auto by day, hold changes overnight." },
] as const;

export function RulesTab() {
  const { d, ns, working, run, setTab } = useAssistantCtx();

  const [windowText, setWindowText] = useState(d.quietWindow || "22:00-07:00");
  const [webhookText, setWebhookText] = useState(d.webhookURL);

  // Seed from live config when it changes.
  useEffect(() => {
    setWindowText(d.quietWindow || "22:00-07:00");
    setWebhookText(d.webhookURL);
  }, [d.quietWindow, d.webhookURL]);

  return (
    <div className="space-y-5">
      <AlertsCard />

      <div className="flex flex-col gap-[18px] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[22px]">
        <div className="flex flex-col gap-0.5">
          <p className="text-base font-semibold text-[var(--fg-primary)]">Autonomy &amp; notifications</p>
          <p className="text-[13px] text-[var(--fg-tertiary)]">How the agent acts on safe fixes.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {MODES.map((m) => (
            <ModeCard
              key={m.value}
              icon={m.icon}
              title={m.label}
              desc={m.desc}
              selected={d.autonomyMode === m.value}
              disabled={working}
              onClick={() => run({ action: "setMode", namespace: ns, mode: m.value, window: windowText })}
            />
          ))}
        </div>

        {d.autonomyMode === "window" && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
            <span className="text-sm text-[var(--fg-secondary)]">Quiet window</span>
            <input
              value={windowText}
              onChange={(e) => setWindowText(e.target.value)}
              placeholder="22:00-07:00"
              className="w-40 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-primary)] px-3 py-2 font-mono text-[13px] text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)] focus:border-[var(--accent-primary)]"
            />
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

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex w-[170px] shrink-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-[var(--fg-primary)]">Notify webhook</span>
            <span className="text-xs text-[var(--fg-tertiary)]">Slack, Discord or ntfy</span>
          </div>
          <div className="flex min-w-[200px] flex-1 items-center gap-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3.5 py-2.5 focus-within:border-[var(--accent-primary)]">
            <LinkIcon className="size-[15px] shrink-0 text-[var(--fg-tertiary)]" />
            <input
              value={webhookText}
              onChange={(e) => setWebhookText(e.target.value)}
              placeholder="Paste webhook URL (optional)"
              className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)]"
            />
          </div>
          <button
            type="button"
            disabled={working}
            onClick={() =>
              run({
                action: "setMode",
                namespace: ns,
                mode: d.autonomyMode,
                window: windowText,
                webhook: webhookText,
              })
            }
            className="shrink-0 rounded-md bg-[var(--accent-primary)] px-5 py-2.5 text-sm font-semibold text-[var(--fg-inverse)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
          >
            Save
          </button>
        </div>

        <div className="flex items-center gap-1.5 text-[13px] text-[var(--fg-tertiary)]">
          <Info className="size-3.5 shrink-0" />
          <span>Signal (SMS) notifications are set up in the</span>
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
                <BellOff className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />
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
  icon: typeof Zap;
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
          <Icon
            className={cn(
              "size-[15px]",
              selected ? "text-[var(--accent-primary)]" : "text-[var(--fg-secondary)]",
            )}
          />
        </span>
        <span className="text-sm font-semibold text-[var(--fg-primary)]">{title}</span>
        {selected && <Check className="ml-auto size-4 text-[var(--accent-primary)]" />}
      </div>
      <p className="text-[12.5px] leading-[1.4] text-[var(--fg-secondary)]">{desc}</p>
    </button>
  );
}
