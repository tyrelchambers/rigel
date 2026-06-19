import { useState } from "react";
import { useAgents, type AgentId } from "@/lib/api";
import { AgentCard } from "./AgentCard";
import { AgentSetup } from "./AgentSetup";

export function AgentsTab() {
  const { data, isLoading } = useAgents();
  const [selected, setSelected] = useState<AgentId | null>(null);

  if (isLoading || !data) {
    return <p style={{ fontSize: 13, color: "#8C8C95" }}>Loading agents…</p>;
  }

  const current = selected ? data.agents.find((a) => a.id === selected) : null;
  if (current) return <AgentSetup agent={current} onBack={() => setSelected(null)} />;

  return (
    <div className="flex flex-col" style={{ gap: 28 }}>
      <div className="flex flex-col" style={{ gap: 10 }}>
        <h2 style={{ fontSize: 28, fontWeight: 700, color: "#FFFFFF" }}>Connect your AI agent</h2>
        <p style={{ fontSize: 16, lineHeight: 1.4, color: "#8C8C95" }}>
          Use an existing subscription or an API key. Your credentials never leave your machine.
        </p>
      </div>
      <div className="grid" style={{ gap: 20, gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
        {data.agents.map((a) => (
          <AgentCard key={a.id} agent={a} onOpen={setSelected} />
        ))}
      </div>
    </div>
  );
}
