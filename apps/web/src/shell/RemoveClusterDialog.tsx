import { Modal } from "@/components/ui/modal";
import { Unplug, ShieldCheck } from "lucide-react";
import { classifyProvider, providerLabel } from "./clusterTile";
import { CLUSTER_ICONS, providerDefaultIcon } from "./clusterIcons";

export function RemoveClusterDialog({
  cluster, open, onOpenChange, onConfirm, busy,
}: {
  cluster: { name: string; server: string } | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const provider = cluster ? classifyProvider(cluster) : "generic";
  const Icon = CLUSTER_ICONS[providerDefaultIcon(provider)].Component;
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Remove cluster" icon={<Unplug className="size-[17px]" />} maxWidth="!max-w-md">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-primary)" }}>Remove this cluster from Rigel?</div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderRadius: 10, background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)" }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-dim)", color: "var(--accent-primary)" }}>
            <Icon size={15} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, color: "var(--fg-primary)", wordBreak: "break-all" }}>{cluster?.name}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)" }}>{providerLabel(provider)}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "11px 12px", borderRadius: 8, background: "var(--surface-elevated)", border: "1px solid var(--border-subtle)" }}>
          <ShieldCheck size={16} color="var(--status-running)" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 13, color: "var(--fg-secondary)", lineHeight: 1.5 }}>This only disconnects it from Rigel. The cluster keeps running on its provider, and you can reconnect anytime.</span>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={() => onOpenChange(false)} style={{ fontSize: 13, color: "var(--fg-secondary)", background: "transparent", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>Cancel</button>
          <button type="button" disabled={busy} onClick={onConfirm} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--fg-primary)", background: "var(--surface-elevated)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 14px", cursor: busy ? "default" : "pointer" }}>
            <Unplug size={14} />{busy ? "Removing…" : "Remove from Rigel"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
