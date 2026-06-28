import { useState } from "react";
import { Lock } from "lucide-react";
import { useAgents, useAssistantAction, type AssistantRequest } from "@/lib/api";
import { useAssistant } from "../../assistant/useAssistant";
import { AssistantConfigSection } from "../../assistant/agents/AssistantConfigSection";
import { AgentsTab as ConnectAgents } from "../agents/AgentsTab";

export function AiAgentsTab() {
  const { data: agents } = useAgents();
  const connected = agents?.agents.some((a) => a.connection === "connected") ?? false;
  const d = useAssistant("default");
  const ns = d.installedNamespace ?? "default";
  // The config writes to the in-cluster assistant, so it's only usable once an
  // agent is connected AND the assistant is installed — otherwise Save would
  // create an orphan assistant-config in the default namespace.
  const canConfigure = connected && d.isInstalled;
  const action = useAssistantAction();
  const [error, setError] = useState<string | null>(null);
  const run = (req: AssistantRequest, onDone?: () => void) => {
    setError(null);
    action
      .mutateAsync(req)
      .then(() => onDone?.())
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="space-y-8">
      <ConnectAgents />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Configure the assistant</h2>
          <p className="text-[13px] leading-snug text-muted-foreground">
            Pick which AI runs each role, manage credentials, and set operational limits.
          </p>
        </div>
        {!canConfigure && (
          <div className="flex items-center gap-2 rounded-md border border-primary bg-[var(--accent-dim)] px-3.5 py-3 text-sm text-foreground">
            <Lock className="size-4 text-primary" />
            {!connected
              ? "Connect an agent to configure the assistant."
              : "Install the assistant from the Assistant page to configure it."}
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className={canConfigure ? "" : "pointer-events-none opacity-40"}>
          <AssistantConfigSection
            roles={d.roles}
            limits={d.limits}
            creds={d.creds}
            credentialSources={d.credentialSources}
            credentialConflicts={d.credentialConflicts}
            credentialNeedsReconcile={d.credentialNeedsReconcile}
            namespace={ns}
            working={action.isPending}
            run={run}
            disabled={!canConfigure}
          />
        </div>
      </section>
    </div>
  );
}
