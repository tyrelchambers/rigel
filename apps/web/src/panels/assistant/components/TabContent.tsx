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
  const { d, tab } = useAssistantCtx();
  const { ready, isInstalled } = d;

  // ABSOLUTE REQUIREMENT: Installer NEVER renders while !ready.deployments.
  if (!ready.deployments) {
    return <ContentSkeleton />;
  }

  if (!isInstalled) {
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
