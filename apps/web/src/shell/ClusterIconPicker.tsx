import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { CLUSTER_ICONS, ICON_PALETTE, type IconId } from "./clusterIcons";

/**
 * Modal icon picker for a cluster tile. Open when `contextName` is non-null.
 * Shows a searchable grid of the icon library; picking one calls `onPick` and
 * the host closes the modal. Replaces the old right-click context-menu grid.
 */
export function ClusterIconPicker({
  contextName,
  currentId,
  onPick,
  onClose,
  deletable,
  onDelete,
}: {
  contextName: string | null;
  currentId: IconId | null;
  onPick: (id: IconId) => void;
  onClose: () => void;
  deletable?: boolean;
  onDelete?: () => void;
}) {
  const [query, setQuery] = useState("");
  const open = contextName !== null;
  const q = query.trim().toLowerCase();
  const ids = q
    ? ICON_PALETTE.filter((id) => CLUSTER_ICONS[id].label.toLowerCase().includes(q) || id.includes(q))
    : ICON_PALETTE;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setQuery("");
          onClose();
        }
      }}
      title={contextName ? `Icon for "${contextName}"` : "Choose an icon"}
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search icons…"
        style={{
          width: "100%",
          marginBottom: 14,
          padding: "8px 10px",
          borderRadius: 8,
          background: "var(--surface-primary)",
          border: "1px solid var(--border-subtle)",
          color: "var(--fg-primary)",
          fontSize: 13,
          outline: "none",
        }}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(48px, 1fr))", gap: 8 }}>
        {ids.map((id) => {
          const Icon = CLUSTER_ICONS[id].Component;
          const selected = id === currentId;
          return (
            <button
              key={id}
              type="button"
              title={CLUSTER_ICONS[id].label}
              onClick={() => {
                setQuery("");
                onPick(id);
              }}
              style={{
                aspectRatio: "1",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                cursor: "pointer",
                color: "var(--fg-primary)",
                background: selected ? "var(--accent-dim)" : "var(--surface-elevated)",
                border: selected ? "1px solid var(--accent-primary)" : "1px solid var(--border-subtle)",
                transition: "background 100ms ease",
              }}
            >
              <Icon size={20} />
            </button>
          );
        })}
      </div>
      {ids.length === 0 && (
        <div style={{ color: "var(--fg-tertiary)", fontSize: 13, padding: "10px 2px" }}>
          No icons match "{query}".
        </div>
      )}
      {deletable && onDelete && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
          <button
            type="button"
            onClick={onDelete}
            style={{ fontSize: 13, color: "#f87171", background: "transparent",
              border: "1px solid var(--border-subtle)", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}
          >
            Delete cluster
          </button>
        </div>
      )}
    </Modal>
  );
}
