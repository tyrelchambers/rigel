import { useState } from "react";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
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
    <div className="flex h-full flex-col gap-4 p-4">
      <SegmentedTabs
        tabs={[
          { id: "releases", label: "Releases" },
          { id: "browse", label: "Browse charts" },
          { id: "install", label: "Install chart" },
        ]}
        active={tab}
        onChange={setTab}
      />
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
  );
}
