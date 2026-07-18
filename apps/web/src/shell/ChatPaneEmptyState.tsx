/**
 * ChatPaneEmptyState — the "copilot isn't set up yet" empty-state block shown in
 * ChatPane's transcript when the AI copilot has no agent connected.
 *
 * Pure presentational: the parent decides when to show it (passing `show`); this
 * component never reads the store.
 */
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSparkles } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useNavigate } from "react-router";

interface ChatPaneEmptyStateProps {
  /** Whether to render the empty state (copilot unconfigured + no messages). */
  show: boolean;
}

export function ChatPaneEmptyState({ show }: ChatPaneEmptyStateProps) {
  const navigate = useNavigate();
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
        <FontAwesomeIcon icon={faSparkles} className="size-[15px]" style={{ color: "var(--accent-primary)" }} />
        <span className="text-xs" style={{ fontWeight: 600, color: "var(--fg-primary)" }}>
          The Rigel copilot isn't set up yet
        </span>
      </div>
      <span className="text-xs" style={{ color: "var(--fg-secondary)", lineHeight: 1.5 }}>
        Chat needs an AI agent. Open Settings, then Agents, to connect one. The rest of the app works
        without it.
      </span>
      <button
        type="button"
        onClick={() => navigate("/settings")}
        className="text-xs"
        style={{
          alignSelf: "flex-start",
          marginTop: 2,
          padding: "5px 12px",
          borderRadius: 6,
          background: "var(--accent-primary)",
          color: "var(--fg-inverse)",
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
