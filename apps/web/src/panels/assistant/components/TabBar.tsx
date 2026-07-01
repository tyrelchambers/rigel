// TabBar — always-rendered tab navigation on the shared segmented rail.
// Skeleton rail → "Set up" pill → real 5-tab rail, per the loading matrix.

import { SegmentedTabs, type SegmentedTab } from "@/components/ui/SegmentedTabs";
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
      <div className="inline-flex gap-[3px] rounded-[10px] p-[3px]" style={{ background: "rgba(255,255,255,0.04)" }}>
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

  const tabs: SegmentedTab[] = [
    { id: "overview", label: "Overview" },
    { id: "needs", label: "Needs you", badge: needsBadge },
    { id: "rules", label: "Rules" },
    { id: "autofix", label: "Auto Fix" },
    { id: "agents", label: "Agents" },
    { id: "activity", label: "Activity", badge: activityBadge },
    { id: "reports", label: "Reports" },
    { id: "settings", label: "Settings" },
  ];

  return <SegmentedTabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabKey)} />;
}
