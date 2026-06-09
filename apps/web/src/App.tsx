import { useEffect } from "react";
import { NavLink, Routes, Route } from "react-router";
import HealthPanel from "./panels/health/HealthPanel";
import PodsPanel from "./panels/pods/PodsPanel";
import DeploymentsPanel from "./panels/deployments/DeploymentsPanel";
import NamespacesPanel from "./panels/namespaces/NamespacesPanel";
import NodesPanel from "./panels/nodes/NodesPanel";
import ServicesPanel from "./panels/services/ServicesPanel";
import ChatPanel from "./panels/chat/ChatPanel";
import { connectCluster } from "@/lib/ws";

const PANELS = ["overview", "pods", "deployments", "namespaces", "nodes", "services", "health", "chat"]; // grows as panels are ported

export default function App() {
  useEffect(() => { connectCluster(); }, []);
  return (
    <div className="flex h-screen">
      <nav className="w-48 border-r p-2 space-y-1">
        {PANELS.map((p) => (
          <NavLink key={p} to={`/${p}`} className="block rounded px-2 py-1 hover:bg-muted capitalize">
            {p}
          </NavLink>
        ))}
      </nav>
      <main className="flex-1 overflow-hidden">
        <Routes>
          {/* Chat owns its full-height scroll layout (no padded wrapper). */}
          <Route path="/chat" element={<ChatPanel />} />
          <Route path="/" element={<div className="p-4">Helmsman Web</div>} />
          <Route path="/health" element={<div className="h-full overflow-auto p-4"><HealthPanel /></div>} />
          <Route path="/pods" element={<div className="h-full overflow-auto p-4"><PodsPanel /></div>} />
          <Route path="/deployments" element={<div className="h-full overflow-auto p-4"><DeploymentsPanel /></div>} />
          <Route path="/namespaces" element={<div className="h-full overflow-auto p-4"><NamespacesPanel /></div>} />
          <Route path="/nodes" element={<div className="h-full overflow-auto p-4"><NodesPanel /></div>} />
          <Route path="/services" element={<div className="h-full overflow-auto p-4"><ServicesPanel /></div>} />
          {PANELS.filter((p) => p !== "health" && p !== "pods" && p !== "deployments" && p !== "namespaces" && p !== "nodes" && p !== "services" && p !== "chat").map((p) => (
            <Route key={p} path={`/${p}`} element={<div className="p-4 capitalize">{p} panel (not yet ported)</div>} />
          ))}
        </Routes>
      </main>
    </div>
  );
}
