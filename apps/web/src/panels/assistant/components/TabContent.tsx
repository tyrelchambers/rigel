// TabContent — decides which content to render based on ready state.
// The loading matrix is implemented here exactly.

import { useAssistantCtx } from "../AssistantContext";
import { ContentSkeleton } from "./ContentSkeleton";
import { InstallView } from "../tabs/InstallView";
import { OverviewTab } from "../tabs/OverviewTab";
import { NeedsYouTab } from "../tabs/NeedsYouTab";
import { RulesTab } from "../tabs/RulesTab";
import { ActivityTab } from "../tabs/ActivityTab";
import { SettingsTab } from "../tabs/SettingsTab";

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

  // Installed — but state-dependent tabs show ContentSkeleton until ready.state.
  const needsState = tab === "overview" || tab === "needs" || tab === "rules" || tab === "activity";
  if (needsState && !ready.state) {
    return <ContentSkeleton />;
  }

  switch (tab) {
    case "overview":
      return <OverviewTab />;
    case "needs":
      return <NeedsYouTab />;
    case "rules":
      return <RulesTab />;
    case "activity":
      return <ActivityTab />;
    case "settings":
      return <SettingsTab />;
  }
}
