/**
 * ChatPaneEmptyState — the "copilot isn't set up yet" empty-state block shown in
 * ChatPane's transcript when the AI copilot has no Claude subscription token.
 *
 * Pure presentational: the parent decides when to show it (passing `show`); this
 * component never reads the store.
 */
import { Sparkles } from "lucide-react";
import { useUiStore } from "@/store/ui";

interface ChatPaneEmptyStateProps {
  /** Whether to render the empty state (copilot unconfigured + no messages). */
  show: boolean;
}

export function ChatPaneEmptyState({ show }: ChatPaneEmptyStateProps) {
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  if (!show) return null;
  return (
    <div
      style={{
        margin: "8px 0",
        padding: "14px",
        borderRadius: 10,
        background: "var(--surface-elevated)",
        border: "1px solid #34353A",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Sparkles size={15} style={{ color: "var(--accent-primary)" }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-primary)" }}>
          The Rigel copilot isn't set up yet
        </span>
      </div>
      <span style={{ fontSize: 12, color: "var(--fg-secondary)", lineHeight: 1.5 }}>
        Chat needs a Claude subscription token. Run{" "}
        <code style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--accent-primary)" }}>
          claude setup-token
        </code>{" "}
        and add it in Settings — the rest of the app works without it.
      </span>
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        style={{
          alignSelf: "flex-start",
          marginTop: 2,
          padding: "5px 12px",
          borderRadius: 6,
          background: "var(--accent-primary)",
          color: "var(--fg-inverse)",
          fontSize: 12,
          fontWeight: 500,
          border: "none",
          cursor: "pointer",
          textDecoration: "none",
        }}
      >
        Open Settings
      </button>
    </div>
  );
}
