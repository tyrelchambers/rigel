// AssistantPanel — thin shell. All state + dialogs live in AssistantProvider;
// all rendering in AssistantBody.

import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { AssistantProvider, useAssistantCtx } from "./AssistantContext";
import { StatusPill } from "./components/primitives";
import { AssistantBody } from "./AssistantBody";

// ---------------------------------------------------------------------------
// Header — reads context so it can show the status pill + pause/resume button.
// ---------------------------------------------------------------------------

function AssistantHeader() {
  const { phase, d, ns, working, run } = useAssistantCtx();

  return (
    <PanelHeader title="Assistant" loading={working || phase === "loading"}>
      {phase === "ready" && (
        <>
          <StatusPill enabled={d.enabled} />
          <Button
            variant={d.enabled ? "destructive" : "default"}
            size="sm"
            disabled={working}
            onClick={() => run({ action: "kill", namespace: ns, enabled: !d.enabled })}
          >
            {d.enabled ? "Pause agent" : "Resume agent"}
          </Button>
        </>
      )}
    </PanelHeader>
  );
}

// ---------------------------------------------------------------------------
// Panel root
// ---------------------------------------------------------------------------

export default function AssistantPanel() {
  return (
    <div className="flex h-full flex-col">
      <AssistantProvider>
        <AssistantHeader />
        <AssistantBody />
      </AssistantProvider>
    </div>
  );
}
