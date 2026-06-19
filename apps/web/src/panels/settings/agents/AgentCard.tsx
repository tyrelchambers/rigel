import { ArrowRight } from "lucide-react";
import { connectionLabel, type AgentId, type AgentView } from "@/lib/api";
import { AgentGlyph } from "./agentGlyphs";

const DOT: Record<AgentView["connection"], string> = {
  connected: "var(--status-running)",
  notConnected: "var(--status-pending)",
  comingSoon: "var(--fg-tertiary)",
};

export function AgentCard({ agent, onOpen }: { agent: AgentView; onOpen: (id: AgentId) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(agent.id)}
      className="flex flex-col gap-4 rounded-xl border p-4 text-left transition-colors hover:bg-[#1B1C1F]"
      style={{ background: "var(--surface-elevated)", borderColor: "var(--border-subtle)" }}
    >
      <div className="flex items-start justify-between">
        <div>
          <div style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>{agent.vendor}</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-primary)" }}>{agent.label}</div>
        </div>
        <span style={{ color: "var(--fg-secondary)" }}><AgentGlyph id={agent.id} /></span>
      </div>

      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5" style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: DOT[agent.connection] }} />
          {connectionLabel(agent.connection)}
        </span>
        <ArrowRight size={14} style={{ color: "var(--fg-tertiary)" }} />
      </div>
    </button>
  );
}
