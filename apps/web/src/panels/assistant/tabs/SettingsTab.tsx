// SettingsTab — agent pod status (with a manual restart) and uninstall.
// Credential and token management now lives in the Agents tab.

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAssistantCtx } from "../AssistantContext";
import { Card } from "../components/primitives";

export function SettingsTab() {
  const { d, ns, working, run, openUninstall } = useAssistantCtx();

  return (
    <div className="space-y-3.5">
      {/* Agent pod */}
      <Card>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Agent pod</p>
          <Button
            variant="secondary"
            size="sm"
            disabled={working}
            onClick={() => run({ action: "restart", namespace: ns })}
          >
            <RotateCcw className="size-4" /> Restart
          </Button>
        </div>
        {d.agentPod ? (
          <div className="mt-1 flex items-center justify-between">
            <div>
              <p className="select-text font-mono text-sm text-muted-foreground">
                {d.agentPod.metadata.name}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                    d.agentPodReason
                      ? "bg-red-500/15 text-red-600 dark:text-red-400"
                      : d.agentPod.status?.phase === "Running"
                        ? "bg-green-500/15 text-green-600 dark:text-green-400"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {d.agentPodReason ?? d.agentPod.status?.phase ?? "Unknown"}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {d.agentPodRestarts} restart{d.agentPodRestarts === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            No agent pod found yet — it may still be scheduling or failing to pull the image.
          </p>
        )}
      </Card>

      {/* Uninstall */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Uninstall</p>
            <p className="text-sm text-muted-foreground">
              Removes the agent Deployment, RBAC, and token. Keeps the audit history.
            </p>
          </div>
          <Button variant="destructive" disabled={working} onClick={openUninstall}>
            Uninstall
          </Button>
        </div>
      </Card>
    </div>
  );
}
