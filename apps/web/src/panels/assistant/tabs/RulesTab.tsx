// RulesTab — autonomy mode, quiet window, webhook, and alert rules.

import { useEffect, useState } from "react";
import { BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Field, Section, inputClass } from "../components/primitives";
import { AlertsCard } from "../AlertsCard";

export function RulesTab() {
  const { d, ns, working, run } = useAssistantCtx();

  const [windowText, setWindowText] = useState(d.quietWindow || "22:00-07:00");
  const [webhookText, setWebhookText] = useState(d.webhookURL);

  // Seed from live config when it changes.
  useEffect(() => {
    setWindowText(d.quietWindow || "22:00-07:00");
    setWebhookText(d.webhookURL);
  }, [d.quietWindow, d.webhookURL]);

  return (
    <div className="space-y-3.5">
      <AlertsCard />

      <Card className="space-y-2">
        <p className="text-sm font-semibold">Autonomy &amp; notifications</p>
        <p className="text-xs text-muted-foreground">How the agent acts on safe fixes.</p>
        <div className="flex gap-1.5">
          {(
            [
              ["Auto", "auto"],
              ["Advisory", "advisory"],
              ["Quiet-hours", "window"],
            ] as const
          ).map(([label, value]) => (
            <Button
              key={value}
              size="sm"
              variant={d.autonomyMode === value ? "default" : "secondary"}
              disabled={working}
              onClick={() =>
                run({ action: "setMode", namespace: ns, mode: value, window: windowText })
              }
            >
              {label}
            </Button>
          ))}
        </div>
        {d.autonomyMode === "window" && (
          <>
            <Field label="Window">
              <input
                value={windowText}
                onChange={(e) => setWindowText(e.target.value)}
                placeholder="22:00-07:00"
                className={inputClass}
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={working}
                onClick={() =>
                  run({ action: "setMode", namespace: ns, mode: "window", window: windowText })
                }
              >
                Save
              </Button>
            </Field>
            <p className="text-xs text-muted-foreground">
              Outside the window (agent timezone), safe fixes are queued for approval instead of
              auto-run.
            </p>
          </>
        )}
        <Field label="Notify webhook">
          <input
            value={webhookText}
            onChange={(e) => setWebhookText(e.target.value)}
            placeholder="Slack/Discord/ntfy URL (optional)"
            className={inputClass}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={working}
            onClick={() =>
              run({ action: "setMode", namespace: ns, mode: d.autonomyMode, window: windowText })
            }
          >
            Save
          </Button>
        </Field>
        <p className="border-t pt-2 text-xs text-muted-foreground">
          Signal notifications are set up in the Settings tab.
        </p>
      </Card>

      {d.silenced.length > 0 && (
        <Section title={`Silenced (${d.silenced.length})`}>
          {d.silenced.map((fp) => (
            <Card key={fp}>
              <div className="flex items-center gap-2">
                <BellOff className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs text-muted-foreground">{fp}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  disabled={working}
                  onClick={() => run({ action: "unsilence", namespace: ns, fingerprint: fp })}
                >
                  Unsilence
                </Button>
              </div>
            </Card>
          ))}
        </Section>
      )}
    </div>
  );
}
