// AssistantBody — the scrollable content area: error banner + strip + tabs.

import { useAssistantCtx } from "./AssistantContext";
import { StatusStrip } from "./components/StatusStrip";
import { TabBar } from "./components/TabBar";
import { TabContent } from "./components/TabContent";

export function AssistantBody() {
  const { actionError } = useAssistantCtx();

  return (
    <div className="flex-1 space-y-3 overflow-auto p-4">
      {actionError && (
        <pre className="select-text rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {actionError}
        </pre>
      )}
      <StatusStrip />
      <TabBar />
      <TabContent />
    </div>
  );
}
