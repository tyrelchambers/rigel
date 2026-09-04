// Settings page — tabbed shell. Six tabs:
//   1. Overview — app/version info + software updates.
//   2. AI agents — connect/configure the AI backend + assistant roles/limits.
//   3. Channels — Signal bridge + Matrix channel.
//   4. App defaults — per-cluster self-host install defaults.
//   5. Failover — DigitalOcean destination for storm-time failover.
//   6. Keyboard — rebind the command shortcuts.

import { useSearchParams } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faTableColumns,
  faRobot,
  faRadio,
  faSliders,
  faSparkles,
  faKeyboard,
  faBoxArchive,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import { TabBar, Tab } from "@/components/ui/Tabs";
import { OverviewTab } from "./tabs/OverviewTab";
import { AiAgentsTab } from "./tabs/AiAgentsTab";
import { ChannelsTab } from "./tabs/ChannelsTab";
import { AppDefaultsTab } from "./tabs/AppDefaultsTab";
import { KeyboardTab } from "./tabs/KeyboardTab";
import { FailoverTab } from "./tabs/FailoverTab";

type SettingsTab = "overview" | "agents" | "channels" | "defaults" | "keyboard" | "failover";
const TABS = [
  { id: "overview", label: "Overview", icon: faTableColumns },
  { id: "agents", label: "AI agents", icon: faRobot },
  { id: "channels", label: "Channels", icon: faRadio },
  { id: "defaults", label: "App defaults", icon: faSliders },
  { id: "failover", label: "Failover", icon: faBoxArchive },
  { id: "keyboard", label: "Keyboard", icon: faKeyboard },
];

function isSettingsTab(value: string | null): value is SettingsTab {
  return (
    value === "overview" ||
    value === "agents" ||
    value === "channels" ||
    value === "defaults" ||
    value === "keyboard" ||
    value === "failover"
  );
}

export default function SettingsPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramTab = searchParams.get("tab");
  const tab: SettingsTab = isSettingsTab(paramTab) ? paramTab : "overview";
  const setTab = (id: SettingsTab) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", id);
        return next;
      },
      { replace: true },
    );
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
            <FontAwesomeIcon icon={faSparkles} /> Setup guide
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
      {tab === "failover" && <FailoverTab />}
      {tab === "keyboard" && <KeyboardTab />}
    </div>
  );
}
