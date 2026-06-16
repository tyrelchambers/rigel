import { useEffect, useRef, useState } from "react";
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
import CertificatesPanel from "./panels/certificates/CertificatesPanel";
import CatalogPanel from "./panels/catalog/CatalogPanel";
import EventsPanel from "./panels/events/EventsPanel";
import LogsPanel from "./panels/logs/LogsPanel";
import AssistantPanel from "./panels/assistant/AssistantPanel";
import SettingsPanel from "./panels/settings/SettingsPanel";
import AccountsPanel from "./panels/accounts/AccountsPanel";
import { connectCluster } from "@/lib/ws";
import { useAuthStatus, useChatConfig } from "@/lib/api";
import { LoginScreen } from "@/shell/LoginScreen";
import { OnboardingWizard } from "@/shell/OnboardingWizard";
import NavStrip from "@/shell/NavStrip";
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

/**
 * Scroll wrapper for panels with their OWN sticky header (e.g. Catalog). Only
 * horizontal padding — a top pad would offset the sticky header below the
 * scrollport edge, letting content leak through the gap above it. The panel
 * supplies its own top/bottom spacing (see .catalog-header / .catalog-root).
 */
function PaddedX({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-auto px-4">
      {children}
    </div>
  );
}

export default function App() {
  // Gate on built-in auth before connecting anything. authed=true when no
  // password is required OR this browser holds a valid session cookie.
  const { data: auth, isLoading: authLoading } = useAuthStatus();
  const authed = auth ? !auth.authRequired || auth.authenticated : false;

  useEffect(() => {
    if (authed) connectCluster();
  }, [authed]);
  const [paletteOpen, setPaletteOpen] = useCommandPalette();

  // First-run onboarding: auto-show once when set up is incomplete (no Claude
  // token) and not previously dismissed; re-openable from Settings via an event.
  const { data: chatConfig } = useChatConfig();
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    const open = () => setShowOnboarding(true);
    window.addEventListener("helmsman:open-setup", open);
    return () => window.removeEventListener("helmsman:open-setup", open);
  }, []);
  useEffect(() => {
    if (authed && chatConfig && !chatConfig.configured && !localStorage.getItem("helmsman_onboarded")) {
      setShowOnboarding(true);
    }
  }, [authed, chatConfig]);
  function closeOnboarding() {
    setShowOnboarding(false);
    localStorage.setItem("helmsman_onboarded", "1");
  }

  // The ChatPane exposes a send() handle so OverviewPanel's
  // "Investigate cluster" button can inject a message.
  const chatHandleRef = useRef<ChatPaneHandle | null>(null);

  function handleInvestigateCluster() {
    chatHandleRef.current?.send(
      "Investigate the cluster's current health. Run kubectl read-only commands across nodes, pods, recent events, deployment status, and CNPG cluster health. Identify anything broken, broken-soon, or unusual. Be concise. Group findings by severity. If everything looks fine, say so briefly."
    );
  }

  // Auth gate: hold rendering until we know the auth state, then show the login
  // screen when a password is required and this browser isn't signed in.
  if (authLoading) {
    return <div style={{ height: "100vh", background: "#0A0A0A" }} />;
  }
  if (auth?.authRequired && !auth.authenticated) {
    return <LoginScreen />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0A0A0A" }}>
      {showOnboarding && <OnboardingWizard onClose={closeOnboarding} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* ── Main row: NavStrip + content column + ChatPane ─────────────────── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <NavStrip />

        {/* ── Content column ───────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0, background: "#0A0A0A" }}>
          {/* Routed panel — the namespace selector now lives inside each
              panel's PanelHeader (see panels/components/PanelHeader.tsx). */}
          <main style={{ flex: 1, overflow: "hidden", background: "#0A0A0A" }}>
            <Routes>
              {/* Logs owns its full-height scroll layout (no padded wrapper). */}
              <Route path="/logs" element={<LogsPanel />} />

              {/* Root → Overview. Overview owns its own top bar + scroll area
                  (full-bleed, like Logs), so it is not wrapped in <Padded>. */}
              <Route
                path="/"
                element={<OverviewPanel onInvestigateCluster={handleInvestigateCluster} />}
              />
              <Route
                path="/overview"
                element={<OverviewPanel onInvestigateCluster={handleInvestigateCluster} />}
              />

              {/* /health — registered but not shown in nav/palette */}
              <Route path="/health" element={<Padded><HealthPanel /></Padded>} />

              {/* Panels using the shared PanelHeader own their full-height
                  scroll layout, so they are rendered without <Padded>. */}
              <Route path="/pods" element={<PodsPanel />} />
              <Route path="/deployments" element={<DeploymentsPanel />} />
              <Route path="/workloads" element={<WorkloadsPanel />} />
              <Route path="/databases" element={<DatabasesPanel />} />
              <Route path="/rightsizing" element={<RightSizingPanel />} />
              <Route path="/namespaces" element={<NamespacesPanel />} />
              <Route path="/nodes" element={<NodesPanel />} />
              <Route path="/services" element={<ServicesPanel />} />
              <Route path="/ingresses" element={<IngressesPanel />} />
              <Route path="/connectivity" element={<ConnectivityPanel />} />
              <Route path="/configmaps" element={<ConfigMapsPanel />} />
              <Route path="/secrets" element={<SecretsPanel />} />
              <Route path="/storage" element={<StoragePanel />} />
              <Route path="/rbac" element={<RbacPanel />} />
              <Route path="/certificates" element={<CertificatesPanel />} />
              <Route path="/catalog" element={<PaddedX><CatalogPanel /></PaddedX>} />
              <Route path="/accounts" element={<Padded><AccountsPanel /></Padded>} />
              <Route path="/events" element={<EventsPanel />} />
              <Route path="/assistant" element={<AssistantPanel />} />
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
