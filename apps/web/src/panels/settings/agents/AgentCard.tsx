import { ArrowRight } from "lucide-react";
import { connectionLabel, type AgentId, type AgentView } from "@/lib/api";
import { AgentGlyph } from "./agentGlyphs";

const ACTIVE = "#5FC9EC";
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
        "flex flex-col justify-between rounded-xl bg-[#18181B] text-left transition-colors hover:bg-[#1c1c20]" +
        (isActive ? "" : " border border-white/[0.08] hover:border-white/20")
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
          <span style={{ fontSize: 12, fontWeight: 500, color: "#8C8C95" }}>{agent.vendor}</span>
          <span style={{ color: "#8C8C95" }}>
            <AgentGlyph id={agent.id} size={18} />
          </span>
        </div>
        <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.15, color: "#FFFFFF" }}>{agent.label}</span>
      </div>

      <div className="flex items-center justify-between">
        <span className="inline-flex items-center" style={{ gap: 7 }}>
          <span
            style={{ width: 7, height: 7, borderRadius: "50%", background: isActive ? ACTIVE : DOT[agent.connection] }}
          />
          <span style={{ fontSize: 12, fontWeight: 500, color: isActive ? ACTIVE : LABEL_COLOR[agent.connection] }}>
            {isActive ? "Active" : connectionLabel(agent.connection)}
          </span>
        </span>
        <ArrowRight size={15} style={{ color: "#8C8C95" }} />
      </div>
    </button>
  );
}
