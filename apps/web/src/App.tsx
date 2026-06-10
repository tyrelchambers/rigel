import { useEffect } from "react";
import { NavLink, Routes, Route } from "react-router";
import OverviewPanel from "./panels/overview/OverviewPanel";
import HealthPanel from "./panels/health/HealthPanel";
import PodsPanel from "./panels/pods/PodsPanel";
import DeploymentsPanel from "./panels/deployments/DeploymentsPanel";
import NamespacesPanel from "./panels/namespaces/NamespacesPanel";
import NodesPanel from "./panels/nodes/NodesPanel";
import ServicesPanel from "./panels/services/ServicesPanel";
import IngressesPanel from "./panels/ingresses/IngressesPanel";
import StoragePanel from "./panels/storage/StoragePanel";
import ConfigMapsPanel from "./panels/configmaps/ConfigMapsPanel";
import SecretsPanel from "./panels/secrets/SecretsPanel";
import WorkloadsPanel from "./panels/workloads/WorkloadsPanel";
import DatabasesPanel from "./panels/databases/DatabasesPanel";
import RightSizingPanel from "./panels/rightsizing/RightSizingPanel";
import RbacPanel from "./panels/rbac/RbacPanel";
import CatalogPanel from "./panels/catalog/CatalogPanel";
import EventsPanel from "./panels/events/EventsPanel";
import LogsPanel from "./panels/logs/LogsPanel";
import ChatPanel from "./panels/chat/ChatPanel";
import { connectCluster } from "@/lib/ws";

const PANELS = ["overview", "catalog", "pods", "deployments", "workloads", "databases", "rightsizing", "namespaces", "nodes", "services", "ingresses", "configmaps", "secrets", "storage", "rbac", "events", "logs", "health", "chat"]; // grows as panels are ported

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
          {/* Chat and Logs own their full-height scroll layout (no padded wrapper). */}
          <Route path="/chat" element={<ChatPanel />} />
          <Route path="/logs" element={<LogsPanel />} />
          <Route path="/" element={<div className="h-full overflow-auto p-4"><OverviewPanel /></div>} />
          <Route path="/overview" element={<div className="h-full overflow-auto p-4"><OverviewPanel /></div>} />
          <Route path="/health" element={<div className="h-full overflow-auto p-4"><HealthPanel /></div>} />
          <Route path="/pods" element={<div className="h-full overflow-auto p-4"><PodsPanel /></div>} />
          <Route path="/deployments" element={<div className="h-full overflow-auto p-4"><DeploymentsPanel /></div>} />
          <Route path="/workloads" element={<div className="h-full overflow-auto p-4"><WorkloadsPanel /></div>} />
          <Route path="/databases" element={<div className="h-full overflow-auto p-4"><DatabasesPanel /></div>} />
          <Route path="/rightsizing" element={<div className="h-full overflow-auto p-4"><RightSizingPanel /></div>} />
          <Route path="/namespaces" element={<div className="h-full overflow-auto p-4"><NamespacesPanel /></div>} />
          <Route path="/nodes" element={<div className="h-full overflow-auto p-4"><NodesPanel /></div>} />
          <Route path="/services" element={<div className="h-full overflow-auto p-4"><ServicesPanel /></div>} />
          <Route path="/ingresses" element={<div className="h-full overflow-auto p-4"><IngressesPanel /></div>} />
          <Route path="/configmaps" element={<div className="h-full overflow-auto p-4"><ConfigMapsPanel /></div>} />
          <Route path="/secrets" element={<div className="h-full overflow-auto p-4"><SecretsPanel /></div>} />
          <Route path="/storage" element={<div className="h-full overflow-auto p-4"><StoragePanel /></div>} />
          <Route path="/rbac" element={<div className="h-full overflow-auto p-4"><RbacPanel /></div>} />
          <Route path="/catalog" element={<div className="h-full overflow-auto p-4"><CatalogPanel /></div>} />
          <Route path="/events" element={<div className="h-full overflow-auto p-4"><EventsPanel /></div>} />
          {PANELS.filter((p) => p !== "overview" && p !== "catalog" && p !== "health" && p !== "pods" && p !== "deployments" && p !== "workloads" && p !== "databases" && p !== "rightsizing" && p !== "namespaces" && p !== "nodes" && p !== "services" && p !== "ingresses" && p !== "configmaps" && p !== "secrets" && p !== "storage" && p !== "rbac" && p !== "events" && p !== "logs" && p !== "chat").map((p) => (
            <Route key={p} path={`/${p}`} element={<div className="p-4 capitalize">{p} panel (not yet ported)</div>} />
          ))}
        </Routes>
      </main>
    </div>
  );
}
