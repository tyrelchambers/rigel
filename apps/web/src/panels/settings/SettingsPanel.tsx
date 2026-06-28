// Settings page — tabbed shell. Three tabs:
//   1. AI agents — connect/configure the AI backend + assistant roles/limits.
//   2. Channels — Signal bridge + Matrix channel.
//   3. App defaults — per-cluster self-host install defaults.

import { useState } from "react";
import { SegmentedTabs, type SegmentedTab } from "@/components/ui/SegmentedTabs";
import { AiAgentsTab } from "./tabs/AiAgentsTab";
import { ChannelsTab } from "./tabs/ChannelsTab";
import { AppDefaultsTab } from "./tabs/AppDefaultsTab";

type SettingsTab = "agents" | "channels" | "defaults";
const TABS: SegmentedTab[] = [
  { id: "agents", label: "AI agents" },
  { id: "channels", label: "Channels" },
  { id: "defaults", label: "App defaults" },
];

export default function SettingsPanel() {
  const [tab, setTab] = useState<SettingsTab>("agents");
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Connect agents, wire up channels, and set self-host defaults.
        </p>
      </div>
      <SegmentedTabs tabs={TABS} active={tab} onChange={(id) => setTab(id as SettingsTab)} />
      {tab === "agents" && <AiAgentsTab />}
      {tab === "channels" && <ChannelsTab />}
      {tab === "defaults" && <AppDefaultsTab />}
    </div>
  );
}
