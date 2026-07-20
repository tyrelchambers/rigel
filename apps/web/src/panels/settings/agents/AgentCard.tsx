import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowRight } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { connectionLabel, type AgentId, type AgentView } from "@/lib/api";
import { AgentGlyph } from "./agentGlyphs";

const DOT: Record<AgentView["connection"], string> = {
  connected: "var(--status-running)", // green
  notInstalled: "var(--status-pending)", // amber — CLI missing
  notSignedIn: "var(--status-pending)", // amber — installed, needs auth
  comingSoon: "var(--fg-tertiary)", // gray
};

export function AgentCard({
  agent,
  isActive = false,
  onOpen,
}: {
  agent: AgentView;
  isActive?: boolean;
  onOpen: (id: AgentId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(agent.id)}
      className={
        "flex flex-col justify-between rounded-xl bg-card text-left transition-colors" +
        // Selected: blue border (set below) + a blue hover background, nothing else.
        // Unselected: neutral subtle border with the standard hover.
        (isActive
          ? " hover:bg-[var(--accent-dim)]"
          : " border border-[var(--border-subtle)] hover:bg-[var(--border-subtle)] hover:border-[var(--border-strong)]")
      }
      style={{
        padding: 16,
        minHeight: 112,
        gap: 16,
        ...(isActive ? { border: "1.5px solid var(--accent-primary)" } : {}),
      }}
    >
      <div className="flex flex-col" style={{ gap: 12 }}>
        <div className="flex items-start justify-between">
          <span className="text-muted-foreground text-xs" style={{ fontWeight: 500 }}>
            {agent.vendor}
          </span>
          <span className="text-muted-foreground">
            <AgentGlyph id={agent.id} size={18} />
          </span>
        </div>
        <span className="text-foreground text-base" style={{ fontWeight: 700, lineHeight: 1.15 }}>
          {agent.label}
        </span>
      </div>

      <div className="flex items-center justify-between">
        <span className="inline-flex items-center" style={{ gap: 7 }}>
          <span
            style={{ width: 7, height: 7, borderRadius: "50%", background: DOT[agent.connection] }}
          />
          <span
            className={`text-xs ${agent.connection === "comingSoon" ? "text-muted-foreground" : "text-foreground"}`}
            style={{ fontWeight: 500, ...(agent.connection === "connected" ? { color: "var(--status-running)" } : {}) }}
          >
            {connectionLabel(agent.connection)}
          </span>
        </span>
        <FontAwesomeIcon icon={faArrowRight} className="size-[15px] text-muted-foreground" />
      </div>
    </button>
  );
}
