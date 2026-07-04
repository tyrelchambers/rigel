// TabBar — always-rendered tab navigation on the shared segmented rail.
// Skeleton rail → "Set up" pill → real 5-tab rail, per the loading matrix.

import { TabBar as TabRail, Tab } from "@/components/ui/Tabs";
import { useAssistantCtx, type TabKey } from "../AssistantContext";
import { Bar } from "./primitives";

export function TabBar() {
  const { phase, d, tab, setTab } = useAssistantCtx();
  const { ready } = d;
  const audit = d.clusterState?.audit ?? [];
  const queue = d.clusterState?.queue ?? [];

  // Loading — skeleton shaped like the segmented rail.
  if (phase === "loading") {
    return (
      <div className="inline-flex gap-[2px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-[3px]">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Bar key={i} className="h-[30px] w-20 rounded-md" />
        ))}
      </div>
    );
  }

  // Not installed — single non-clickable "Set up" pill.
  if (phase === "install") {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1.5 rounded-full bg-muted px-3.5 py-1.5 text-sm font-medium text-muted-foreground">
          Set up
        </span>
      </div>
    );
  }

  // Installed — the segmented rail. Badges only when ready.state.
  const needsBadge = ready.state ? queue.length + d.liveIssues.length : undefined;
  const activityBadge = ready.state ? audit.length : undefined;

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "needs", label: "Needs you", badge: needsBadge },
    { id: "alerts", label: "Alerts" },
    { id: "autofix", label: "Auto Fix" },
    { id: "agents", label: "Agents" },
    { id: "activity", label: "Activity", badge: activityBadge },
    { id: "reports", label: "Reports" },
    { id: "audits", label: "Audits" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <TabRail value={tab} onValueChange={(id) => setTab(id as TabKey)}>
      {tabs.map((t) => (
        <Tab key={t.id} value={t.id} badge={t.badge}>{t.label}</Tab>
      ))}
    </TabRail>
  );
}
