import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronRight, Server } from "lucide-react";
import { SegmentedTabs, type SegmentedTab } from "@/components/ui/SegmentedTabs";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { goToResource } from "@/lib/resourceNav";
import { computeRelated, relatedKindsFor, type RelatedRef } from "@/lib/relatedResources";

export function RelatedResources({ sourceKind, source }: { sourceKind: string; source: Record<string, any> }) {
  const navigate = useNavigate();
  const resources = useCluster((s) => s.resources);
  const namespace = source?.metadata?.namespace ?? "default";
  const kinds = relatedKindsFor(sourceKind);
  const [active, setActive] = useState("");

  useEffect(() => {
    for (const k of kinds) subscribe(k, k === "nodes" ? "*" : namespace);
    return () => { for (const k of kinds) unsubscribe(k, k === "nodes" ? "*" : namespace); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKind, namespace]);

  const groups = computeRelated(sourceKind, source, resources as Record<string, Record<string, any>>);
  if (groups.length === 0) {
    return <div style={{ fontSize: 13, color: "#8C8C95", padding: "8px 0" }}>No related resources.</div>;
  }

  // Derive the active kind so a group that disappears (a watch unloads, a group
  // empties out) falls back to the first tab without an effect.
  const activeKind = groups.some((g) => g.kind === active) ? active : groups[0].kind;
  const activeGroup = groups.find((g) => g.kind === activeKind)!;
  const tabs: SegmentedTab[] = groups.map((g) => ({ id: g.kind, label: g.label, badge: g.items.length }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: 1.2, color: "#7E7E87" }}>RELATED</span>
      <div style={{ background: "#141417", borderRadius: 12, border: "1px solid rgba(255,255,255,0.05)", overflow: "hidden" }}>
        {/* Rail: one tab per related kind. Scrolls horizontally if the kind list
            outgrows the panel (a pod has up to ~8 related kinds). */}
        <div style={{ padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.04)", overflowX: "auto" }}>
          <SegmentedTabs tabs={tabs} active={activeKind} onChange={setActive} />
        </div>
        {activeGroup.items.map((it) => <Row key={it.key} item={it} onGo={() => goToResource(navigate, it)} />)}
      </div>
    </div>
  );
}

function Row({ item, onGo }: { item: RelatedRef; onGo: () => void }) {
  const missing = item.status === "missing";
  const dot = item.status === "warn" ? "#F59E0B" : "#10B981";
  const common = { display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", width: "100%", borderBottom: "1px solid rgba(255,255,255,0.04)", background: "transparent" } as const;
  if (missing) {
    return (
      <div style={{ ...common }}>
        <span style={{ flex: 1, minWidth: 0, fontFamily: "ui-monospace, monospace", fontSize: 13, color: "#8C8C95", textDecoration: "line-through", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
        <span style={{ borderRadius: 999, background: "#FF5A5A1A", padding: "3px 10px", fontSize: 11, fontWeight: 600, color: "#FF6B6B" }}>missing</span>
      </div>
    );
  }
  return (
    <button type="button" onClick={onGo} style={{ ...common, border: "none", cursor: "pointer", textAlign: "left" }} className="hover:bg-[#1B1C1F] transition-colors">
      <span style={{ flex: 1, minWidth: 0, fontFamily: "ui-monospace, monospace", fontSize: 13, fontWeight: 500, color: "#A6A6AE", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
      {item.node && (
        <span title={`Node: ${item.node}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, minWidth: 0, fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#6B6B73" }}>
          <Server size={12} style={{ color: "#6B6B73", flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.node}</span>
        </span>
      )}
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />
      <ChevronRight size={15} style={{ color: "#6B6B73", flexShrink: 0 }} />
    </button>
  );
}
