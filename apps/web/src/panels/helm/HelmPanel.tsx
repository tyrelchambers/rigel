import { useState } from "react";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import type { HelmRelease } from "@rigel/k8s/src/helm";
import { ReleasesView } from "./ReleasesView";
import { InstallChartView } from "./InstallChartView";

export default function HelmPanel() {
  const [tab, setTab] = useState("releases");
  const [prefill, setPrefill] = useState<HelmRelease | null>(null);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <SegmentedTabs
        tabs={[{ id: "releases", label: "Releases" }, { id: "install", label: "Install chart" }]}
        active={tab}
        onChange={setTab}
      />
      {tab === "releases" ? (
        <ReleasesView onUpgrade={(r) => { setPrefill(r); setTab("install"); }} />
      ) : (
        <InstallChartView prefill={prefill} />
      )}
    </div>
  );
}
