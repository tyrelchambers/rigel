// AssistantBody — the scrollable content area: error banner + strip + tabs.

import { useAssistantCtx } from "./AssistantContext";
import { useEntitlement } from "@/shell/useEntitlement";
import { StatusStrip } from "./components/StatusStrip";
import { TabBar } from "./components/TabBar";
import { TabContent } from "./components/TabContent";
import { AssistantGate } from "./components/AssistantGate";

export function AssistantBody() {
  const { actionError, phase } = useAssistantCtx();
  const { payload } = useEntitlement();
  const entitled = !!payload?.agentAutonomy;
  const gated = phase === "ready" && !entitled;

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
      {actionError && (
        <pre className="select-text rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {actionError}
        </pre>
      )}
      {gated ? (
        <AssistantGate />
      ) : (
        <>
          <StatusStrip />
          <TabBar />
          <TabContent />
        </>
      )}
    </div>
  );
}
