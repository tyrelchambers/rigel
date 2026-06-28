// AgentsTab — thin wrapper that feeds the installed assistant's live config
// into AssistantConfigSection. All logic lives in the reusable component.
import { useAssistantCtx } from "../AssistantContext";
import { AssistantConfigSection } from "../agents/AssistantConfigSection";

export function AgentsTab() {
  const { d, ns, working, run } = useAssistantCtx();
  return (
    <div className="space-y-3.5">
      <div>
        <p className="text-sm font-semibold">Agents &amp; providers</p>
        <p className="text-xs text-muted-foreground">
          Pick which AI runs each role of the Assistant. Model changes apply on the next poll; adding
          a credential restarts the agent.
        </p>
      </div>
      <AssistantConfigSection
        roles={d.roles}
        limits={d.limits}
        creds={d.creds}
        credentialSources={d.credentialSources}
        credentialConflicts={d.credentialConflicts}
        credentialNeedsReconcile={d.credentialNeedsReconcile}
        namespace={ns}
        working={working}
        run={run}
      />
    </div>
  );
}
