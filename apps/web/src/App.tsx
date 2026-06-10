import { useEffect, useRef } from "react";
import { Routes, Route } from "react-router";
import OverviewPanel from "./panels/overview/OverviewPanel";
import HealthPanel from "./panels/health/HealthPanel";
import PodsPanel from "./panels/pods/PodsPanel";
import DeploymentsPanel from "./panels/deployments/DeploymentsPanel";
import NamespacesPanel from "./panels/namespaces/NamespacesPanel";
import NodesPanel from "./panels/nodes/NodesPanel";
import ServicesPanel from "./panels/services/ServicesPanel";
import IngressesPanel from "./panels/ingresses/IngressesPanel";
import ConnectivityPanel from "./panels/connectivity/ConnectivityPanel";
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
import AssistantPanel from "./panels/assistant/AssistantPanel";
import SettingsPanel from "./panels/settings/SettingsPanel";
import AccountsPanel from "./panels/accounts/AccountsPanel";
import { connectCluster } from "@/lib/ws";
import NavStrip from "@/shell/NavStrip";
import NamespaceBar from "@/shell/NamespaceBar";
import StatusBar from "@/shell/StatusBar";
import ChatPane, { type ChatPaneHandle } from "@/shell/ChatPane";
import { CommandPalette, useCommandPalette } from "@/shell/CommandPalette";

/** Wrapper for panels that need padding + vertical scroll. */
function Padded({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-auto p-4">
      {children}
    </div>
  );
}

export default function App() {
  useEffect(() => { connectCluster(); }, []);
  const [paletteOpen, setPaletteOpen] = useCommandPalette();

  // The ChatPane exposes a send() handle so OverviewPanel's
  // "Investigate cluster" button can inject a message.
  const chatHandleRef = useRef<ChatPaneHandle | null>(null);

  function handleInvestigateCluster() {
    chatHandleRef.current?.send(
      "Investigate the cluster's current health. Run kubectl read-only commands across nodes, pods, recent events, deployment status, and CNPG cluster health. Identify anything broken, broken-soon, or unusual. Be concise. Group findings by severity. If everything looks fine, say so briefly."
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0A0A0A" }}>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* ── Main row: NavStrip + content column + ChatPane ─────────────────── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <NavStrip />

        {/* ── Content column ───────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0, background: "#0A0A0A" }}>
          {/* Namespace bar — only renders on namespace-scoped routes */}
          <NamespaceBar />

          {/* Routed panel */}
          <main style={{ flex: 1, overflow: "hidden", background: "#0A0A0A" }}>
            <Routes>
              {/* Logs owns its full-height scroll layout (no padded wrapper). */}
              <Route path="/logs" element={<LogsPanel />} />

              {/* Root → Overview */}
              <Route
                path="/"
                element={
                  <Padded>
                    <OverviewPanel onInvestigateCluster={handleInvestigateCluster} />
                  </Padded>
                }
              />
              <Route
                path="/overview"
                element={
                  <Padded>
                    <OverviewPanel onInvestigateCluster={handleInvestigateCluster} />
                  </Padded>
                }
              />

              {/* /health — registered but not shown in nav/palette */}
              <Route path="/health" element={<Padded><HealthPanel /></Padded>} />

              <Route path="/pods" element={<Padded><PodsPanel /></Padded>} />
              <Route path="/deployments" element={<Padded><DeploymentsPanel /></Padded>} />
              <Route path="/workloads" element={<Padded><WorkloadsPanel /></Padded>} />
              <Route path="/databases" element={<Padded><DatabasesPanel /></Padded>} />
              <Route path="/rightsizing" element={<Padded><RightSizingPanel /></Padded>} />
              <Route path="/namespaces" element={<Padded><NamespacesPanel /></Padded>} />
              <Route path="/nodes" element={<Padded><NodesPanel /></Padded>} />
              <Route path="/services" element={<Padded><ServicesPanel /></Padded>} />
              <Route path="/ingresses" element={<Padded><IngressesPanel /></Padded>} />
              <Route path="/connectivity" element={<Padded><ConnectivityPanel /></Padded>} />
              <Route path="/configmaps" element={<Padded><ConfigMapsPanel /></Padded>} />
              <Route path="/secrets" element={<Padded><SecretsPanel /></Padded>} />
              <Route path="/storage" element={<Padded><StoragePanel /></Padded>} />
              <Route path="/rbac" element={<Padded><RbacPanel /></Padded>} />
              <Route path="/catalog" element={<Padded><CatalogPanel /></Padded>} />
              <Route path="/accounts" element={<Padded><AccountsPanel /></Padded>} />
              <Route path="/events" element={<Padded><EventsPanel /></Padded>} />
              <Route path="/assistant" element={<Padded><AssistantPanel /></Padded>} />
              <Route path="/settings" element={<Padded><SettingsPanel /></Padded>} />
            </Routes>
          </main>
        </div>

        {/* ── ChatPane — always visible, right side ─────────────────────────── */}
        <div style={{ position: "relative", flexShrink: 0 }}>
          <ChatPane handleRef={chatHandleRef} />
        </div>

      </div>

      {/* ── StatusBar — full width at the bottom ────────────────────────────── */}
      <StatusBar />
    </div>
  );
}
