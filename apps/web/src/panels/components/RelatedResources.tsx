import { useEffect } from "react";
import { useNavigate } from "react-router";
import * as Lucide from "lucide-react";
import { ChevronRight } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { goToResource } from "@/lib/resourceNav";
import { computeRelated, relatedKindsFor, type RelatedRef } from "@/lib/relatedResources";

export function RelatedResources({ sourceKind, source }: { sourceKind: string; source: Record<string, any> }) {
  const navigate = useNavigate();
  const resources = useCluster((s) => s.resources);
  const namespace = source?.metadata?.namespace ?? "default";
  const kinds = relatedKindsFor(sourceKind);

  useEffect(() => {
    for (const k of kinds) subscribe(k, k === "nodes" ? "*" : namespace);
    return () => { for (const k of kinds) unsubscribe(k, k === "nodes" ? "*" : namespace); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKind, namespace]);

  const groups = computeRelated(sourceKind, source, resources as Record<string, Record<string, any>>);
  if (groups.length === 0) {
    return <div style={{ fontSize: 13, color: "#8C8C95", padding: "8px 0" }}>No related resources.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: 1.2, color: "#7E7E87" }}>RELATED</span>
      <div style={{ background: "#141417", borderRadius: 12, border: "1px solid rgba(255,255,255,0.05)", overflow: "hidden" }}>
        {groups.map((g) => {
          const Icon = (Lucide as any)[lucideName(g.icon)] ?? Lucide.Box;
          return (
            <div key={g.kind}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 16px", background: "#1A1A1E", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <Icon size={14} style={{ color: "#8C8C95" }} />
                <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.4, color: "#C9C9D1" }}>{g.label}</span>
                <span style={{ borderRadius: 999, background: "rgba(255,255,255,0.05)", padding: "2px 8px", fontSize: 11, fontWeight: 600, color: "#8C8C95" }}>{g.items.length}</span>
              </div>
              {g.items.map((it) => <Row key={it.key} item={it} onGo={() => goToResource(navigate, it)} />)}
            </div>
          );
        })}
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
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />
      <ChevronRight size={15} style={{ color: "#6B6B73", flexShrink: 0 }} />
    </button>
  );
}

// "share-2" -> "Share2", "file-text" -> "FileText", "key-round" -> "KeyRound"
function lucideName(icon: string): string {
  return icon.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}
