import { ArrowRight } from "lucide-react";
import { connectionLabel, type AgentId, type AgentView } from "@/lib/api";
import { AgentGlyph } from "./agentGlyphs";

// The active-agent treatment uses a distinct cyan (not the sky accent), shared with
// AgentSetup's active indicator — kept as a bespoke value, not a design token.
const ACTIVE = "#5FC9EC";
const DOT: Record<AgentView["connection"], string> = {
  connected: "var(--status-running)",
  notConnected: "var(--status-pending)",
  comingSoon: "var(--fg-tertiary)",
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
        "flex flex-col justify-between rounded-xl bg-card text-left transition-colors hover:bg-[var(--border-subtle)]" +
        (isActive ? "" : " border border-[var(--border-subtle)] hover:border-[var(--border-strong)]")
      }
      style={{
        padding: 16,
        minHeight: 112,
        gap: 16,
        ...(isActive ? { border: `1.5px solid ${ACTIVE}` } : {}),
      }}
    >
      <div className="flex flex-col" style={{ gap: 12 }}>
        <div className="flex items-start justify-between">
          <span className="text-muted-foreground" style={{ fontSize: 12, fontWeight: 500 }}>
            {agent.vendor}
          </span>
          <span className="text-muted-foreground">
            <AgentGlyph id={agent.id} size={18} />
          </span>
        </div>
        <span className="text-foreground" style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.15 }}>
          {agent.label}
        </span>
      </div>

      <div className="flex items-center justify-between">
        <span className="inline-flex items-center" style={{ gap: 7 }}>
          <span
            style={{ width: 7, height: 7, borderRadius: "50%", background: isActive ? ACTIVE : DOT[agent.connection] }}
          />
          <span
            className={
              isActive ? undefined : agent.connection === "comingSoon" ? "text-muted-foreground" : "text-foreground"
            }
            style={{ fontSize: 12, fontWeight: 500, ...(isActive ? { color: ACTIVE } : {}) }}
          >
            {isActive ? "Active" : connectionLabel(agent.connection)}
          </span>
        </span>
        <ArrowRight size={15} className="text-muted-foreground" />
      </div>
    </button>
  );
}
