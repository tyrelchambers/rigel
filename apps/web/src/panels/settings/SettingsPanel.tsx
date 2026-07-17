// Settings page — tabbed shell. Four tabs:
//   1. Overview — app/version info + software updates.
//   2. AI agents — connect/configure the AI backend + assistant roles/limits.
//   3. Channels — Signal bridge + Matrix channel.
//   4. App defaults — per-cluster self-host install defaults.

import { useState } from "react";
import { LayoutDashboard, Bot, Radio, SlidersHorizontal, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TabBar, Tab } from "@/components/ui/Tabs";
import { OverviewTab } from "./tabs/OverviewTab";
import { AiAgentsTab } from "./tabs/AiAgentsTab";
import { ChannelsTab } from "./tabs/ChannelsTab";
import { AppDefaultsTab } from "./tabs/AppDefaultsTab";

type SettingsTab = "overview" | "agents" | "channels" | "defaults";
const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "agents", label: "AI agents", icon: Bot },
  { id: "channels", label: "Channels", icon: Radio },
  { id: "defaults", label: "App defaults", icon: SlidersHorizontal },
];

export default function SettingsPanel() {
  const [tab, setTab] = useState<SettingsTab>("overview");
  return (
    <div className="flex w-full flex-col gap-10 px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Connect agents, wire up channels, and set self-host defaults.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.dispatchEvent(new Event("rigel:open-setup"))}
          >
            <Sparkles /> Setup guide
          </Button>
          <TabBar value={tab} onValueChange={(id) => setTab(id as SettingsTab)}>
            {TABS.map((t) => (
              <Tab key={t.id} value={t.id} icon={t.icon}>{t.label}</Tab>
            ))}
          </TabBar>
        </div>
      </div>
      {tab === "overview" && <OverviewTab />}
      {tab === "agents" && <AiAgentsTab />}
      {tab === "channels" && <ChannelsTab />}
      {tab === "defaults" && <AppDefaultsTab />}
    </div>
  );
}
