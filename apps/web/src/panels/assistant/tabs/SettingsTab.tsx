// SettingsTab — agent pod status, credentials, and uninstall.

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAssistantCtx } from "../AssistantContext";
import { Card, inputClass } from "../components/primitives";

export function SettingsTab() {
  const { d, ns, working, run, openUninstall } = useAssistantCtx();
  const [newToken, setNewToken] = useState("");

  return (
    <div className="space-y-3.5">
      {/* Agent pod */}
      <Card>
        <p className="text-sm font-semibold">Agent pod</p>
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

      {/* Credentials & maintenance */}
      <Card className="space-y-2">
        <p className="text-sm font-semibold">Credentials &amp; maintenance</p>
        <p className="text-sm text-muted-foreground">
          Update the subscription token (run{" "}
          <span className="font-mono">claude setup-token</span> and paste it). Saving replaces the
          Secret and rolls the agent so it picks up the new token. Use after a 401 / token expiry.
        </p>
        <input
          type="password"
          autoComplete="off"
          value={newToken}
          onChange={(e) => setNewToken(e.target.value)}
          placeholder="New CLAUDE_CODE_OAUTH_TOKEN"
          className={`w-full ${inputClass}`}
        />
        <div className="flex gap-2">
          <Button
            disabled={working || newToken.trim() === ""}
            onClick={() =>
              run(
                { action: "updateToken", namespace: ns, token: newToken.trim() },
                () => setNewToken(""),
              )
            }
          >
            Update token &amp; restart
          </Button>
          <Button
            variant="secondary"
            disabled={working}
            onClick={() => run({ action: "restart", namespace: ns })}
          >
            <RotateCcw className="size-4" /> Restart agent
          </Button>
        </div>
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
