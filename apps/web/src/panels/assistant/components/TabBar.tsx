// TabBar — always-rendered pill navigation.
// Skeleton pills → "Set up" pill → real 5 pills, per the loading matrix.

import { useAssistantCtx } from "../AssistantContext";
import { Bar, TabPill } from "./primitives";

export function TabBar() {
  const { phase, d, tab, setTab } = useAssistantCtx();
  const { ready } = d;
  const audit = d.clusterState?.audit ?? [];
  const queue = d.clusterState?.queue ?? [];

  // Loading — 5 skeleton pills.
  if (phase === "loading") {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <Bar key={i} className="h-7 w-20 rounded-full" />
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

  // Installed — 5 real pills. Badges only when ready.state.
  const needsBadge = ready.state ? queue.length + d.liveIssues.length : undefined;
  const activityBadge = ready.state ? audit.length : undefined;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <TabPill active={tab === "overview"} onClick={() => setTab("overview")}>
        Overview
      </TabPill>
      <TabPill
        active={tab === "needs"}
        onClick={() => setTab("needs")}
        badge={needsBadge}
      >
        Needs you
      </TabPill>
      <TabPill active={tab === "rules"} onClick={() => setTab("rules")}>
        Rules
      </TabPill>
      <TabPill
        active={tab === "activity"}
        onClick={() => setTab("activity")}
        badge={activityBadge}
      >
        Activity
      </TabPill>
      <TabPill active={tab === "settings"} onClick={() => setTab("settings")}>
        Settings
      </TabPill>
    </div>
  );
}
