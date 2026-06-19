import { ArrowRight } from "lucide-react";
import { connectionLabel, type AgentId, type AgentView } from "@/lib/api";
import { AgentGlyph } from "./agentGlyphs";

const DOT: Record<AgentView["connection"], string> = {
  connected: "#34D07F",
  notConnected: "#F59E0B",
  comingSoon: "#4A4A52",
};
const LABEL_COLOR: Record<AgentView["connection"], string> = {
  connected: "#FFFFFF",
  notConnected: "#FFFFFF",
  comingSoon: "#8C8C95",
};

export function AgentCard({ agent, onOpen }: { agent: AgentView; onOpen: (id: AgentId) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(agent.id)}
      className="flex flex-col justify-between rounded-[14px] border border-white/[0.08] bg-[#18181B] text-left transition-colors hover:border-white/20 hover:bg-[#1c1c20]"
      style={{ padding: 24, minHeight: 158 }}
    >
      <div className="flex flex-col" style={{ gap: 18 }}>
        <div className="flex items-start justify-between">
          <span style={{ fontSize: 13, fontWeight: 500, color: "#8C8C95" }}>{agent.vendor}</span>
          <span style={{ color: "#8C8C95" }}>
            <AgentGlyph id={agent.id} size={22} />
          </span>
        </div>
        <span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1, color: "#FFFFFF" }}>{agent.label}</span>
      </div>

      <div className="flex items-center justify-between">
        <span className="inline-flex items-center" style={{ gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: DOT[agent.connection] }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: LABEL_COLOR[agent.connection] }}>
            {connectionLabel(agent.connection)}
          </span>
        </span>
        <ArrowRight size={18} style={{ color: "#8C8C95" }} />
      </div>
    </button>
  );
}
