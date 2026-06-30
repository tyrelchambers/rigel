// TabContent — decides which content to render based on ready state.
// The loading matrix is implemented here exactly.

import { Loader } from "@/components/Loader";
import { useAssistantCtx } from "../AssistantContext";
import { ContentSkeleton } from "./ContentSkeleton";
import { InstallView } from "../tabs/InstallView";
import { OverviewTab } from "../tabs/OverviewTab";
import { NeedsYouTab } from "../tabs/NeedsYouTab";
import { RulesTab } from "../tabs/RulesTab";
import { AutoFixTab } from "../tabs/AutoFixTab";
import { ActivityTab } from "../tabs/ActivityTab";
import { SettingsTab } from "../tabs/SettingsTab";
import { AgentsTab } from "../tabs/AgentsTab";

export function TabContent() {
  const { phase, d, tab } = useAssistantCtx();
  const { ready } = d;

  // Phase-gated so the Installer never appears during load (debounced verdict).
  if (phase === "loading") {
    return <ContentSkeleton />;
  }

  if (phase === "install") {
    return <InstallView />;
  }

  // Installed but the agent hasn't written its first state yet — i.e. it's
  // starting up right after an install. Show progress instead of a bare skeleton.
  const needsState =
    tab === "overview" || tab === "needs" || tab === "rules" || tab === "autofix" || tab === "activity";
  if (needsState && !ready.state) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Loader size={24} className="text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Setting up the assistant…</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Manifests applied. Waiting for the agent pod to start and report in — this takes a few seconds.
          </p>
        </div>
      </div>
    );
  }

  switch (tab) {
    case "overview":
      return <OverviewTab />;
    case "needs":
      return <NeedsYouTab />;
    case "rules":
      return <RulesTab />;
    case "autofix":
      return <AutoFixTab />;
    case "agents":
      return <AgentsTab />;
    case "activity":
      return <ActivityTab />;
    case "settings":
      return <SettingsTab />;
  }
}
