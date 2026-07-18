import { useState } from "react";
import { faRectangleList, faBoxOpen, faStore } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { TabBar, Tab } from "@/components/ui/Tabs";
import { PanelHeader } from "@/panels/components/PanelHeader";
import type { HelmRelease } from "@rigel/k8s/src/helm";
import { ReleasesView } from "./ReleasesView";
import { InstallChartView } from "./InstallChartView";
import { BrowseChartsView } from "./BrowseChartsView";
import type { ChartPrefill } from "./installPrefill";

export default function HelmPanel() {
  const [tab, setTab] = useState("releases");
  const [prefill, setPrefill] = useState<HelmRelease | null>(null);
  const [chartPrefill, setChartPrefill] = useState<ChartPrefill | null>(null);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Helm" subtitle="Installed releases and chart repositories">
        <TabBar value={tab} onValueChange={setTab}>
          <Tab value="releases" icon={faRectangleList}>Releases</Tab>
          <Tab value="browse" icon={faStore}>Browse charts</Tab>
          <Tab value="install" icon={faBoxOpen}>Install chart</Tab>
        </TabBar>
      </PanelHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        {tab === "releases" ? (
        <ReleasesView onUpgrade={(r) => { setPrefill(r); setChartPrefill(null); setTab("install"); }} />
      ) : tab === "browse" ? (
        <BrowseChartsView
          onPickChart={(c) => {
            setChartPrefill({ source: c.source, version: c.version || null, suggestedName: c.name });
            setTab("install");
          }}
        />
      ) : (
        <InstallChartView prefill={prefill} chartPrefill={chartPrefill} />
      )}
      </div>
    </div>
  );
}
