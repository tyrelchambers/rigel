import { useCallback, useEffect, useRef, useState } from "react";
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
import ApplyYamlPanel from "./panels/apply/ApplyYamlPanel";
import GitOpsPanel from "./panels/gitops/GitOpsPanel";
import { TerminalDrawer, TOGGLE_TERMINAL_EVENT } from "@/shell/TerminalDrawer";
import { ResourceYamlViewer } from "@/components/ResourceYamlViewer";
import { connectCluster } from "@/lib/ws";
import { useChatConfig } from "@/lib/api";
import { rigel } from "@/lib/desktop";
import { OnboardingWizard } from "@/shell/OnboardingWizard";
import NavStrip from "@/shell/NavStrip";
import StatusBar from "@/shell/StatusBar";
import ChatPane, { type ChatPaneHandle } from "@/shell/ChatPane";
import { CommandPalette, useCommandPalette } from "@/shell/CommandPalette";
import { GlobalHeader } from "@/shell/GlobalHeader";
import { loadSidebarCollapsed, saveSidebarCollapsed } from "@/shell/navCollapse";

function readTerminalOpen(): boolean {
  try { return localStorage.getItem("helmsman.terminal.open") === "1"; } catch { return false; }
}
function persistTerminalOpen(open: boolean): void {
  try { localStorage.setItem("helmsman.terminal.open", open ? "1" : "0"); } catch { /* ignore */ }
}

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
  useEffect(() => {
    connectCluster();
  }, []);
  const [paletteOpen, setPaletteOpen] = useCommandPalette();

  // Whole-sidebar collapse (icon-only rail). Owned here, persisted on change,
  // driven by the GlobalHeader toggle. Distinct from the per-group nav collapse.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(loadSidebarCollapsed);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      saveSidebarCollapsed(next);
      return next;
    });
  }, []);

  // First-run onboarding: auto-show once when set up is incomplete (no Claude
  // token) and not previously dismissed; re-openable from Settings via an event.
  // On desktop, prepends a required "About you" step when needsSignup() is true.
  const { data: chatConfig } = useChatConfig();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [requireAboutYou, setRequireAboutYou] = useState(false);
  useEffect(() => {
    const open = () => setShowOnboarding(true);
    window.addEventListener("helmsman:open-setup", open);
    return () => window.removeEventListener("helmsman:open-setup", open);
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const needs = rigel ? await rigel.needsSignup() : false;
      if (cancelled) return;
      if (needs) {
        setRequireAboutYou(true);
        setShowOnboarding(true);
        return;
      }
      // Existing optional-onboarding condition:
      if (chatConfig && !chatConfig.configured && !localStorage.getItem("helmsman_onboarded")) {
        setShowOnboarding(true);
      }
    })();
    return () => { cancelled = true; };
  }, [chatConfig]);
  function closeOnboarding() {
    if (requireAboutYou) return; // guarded until About-you is complete
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

  // Chat-pane visibility — toggle with ⌘J / Ctrl+J, persisted across reloads.
  // The pane is kept mounted (hidden via display:none) so the conversation and
  // its live watches survive hiding/showing.
  const [chatHidden, setChatHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem("helmsman.chat.hidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleChat = useCallback(() => {
    setChatHidden((h) => {
      const next = !h;
      try {
        localStorage.setItem("helmsman.chat.hidden", next ? "1" : "0");
      } catch {
        /* ignore quota / private-browsing errors */
      }
      return next;
    });
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌘J (mac) / Ctrl+J — toggle the chat pane. preventDefault covers the
      // Windows/Linux "open downloads" default.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleChat();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleChat]);

  // Terminal drawer — bottom-mounted persistent shell. Toggled with ⌃` and from
  // the StatusBar chip / nav item / command palette via the shared event. Kept
  // mounted so the PTY + scrollback survive hide/show.
  const [terminalOpen, setTerminalOpen] = useState<boolean>(readTerminalOpen);
  const toggleTerminal = useCallback(() => setTerminalOpen((o) => { persistTerminalOpen(!o); return !o; }), []);
  const closeTerminal = useCallback(() => { persistTerminalOpen(false); setTerminalOpen(false); }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌃` — the terminal-toggle muscle memory. Plain Ctrl only (no ⌘/Alt).
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        toggleTerminal();
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(TOGGLE_TERMINAL_EVENT, toggleTerminal);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(TOGGLE_TERMINAL_EVENT, toggleTerminal);
    };
  }, [toggleTerminal]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--surface-primary)" }}>
      {showOnboarding && (
        <OnboardingWizard
          onClose={closeOnboarding}
          requireAboutYou={requireAboutYou}
          onAboutYouDone={() => setRequireAboutYou(false)}
        />
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* ── Global header — slim full-width bar above the whole app ─────────── */}
      <GlobalHeader
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        onOpenSearch={() => setPaletteOpen(true)}
      />

      {/* ── Main row: NavStrip + content column + ChatPane ─────────────────── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <NavStrip collapsed={sidebarCollapsed} />

        {/* ── Content column ───────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0, background: "var(--surface-primary)" }}>
          {/* Routed panel — the namespace selector now lives inside each
              panel's PanelHeader (see panels/components/PanelHeader.tsx). */}
          <main style={{ flex: 1, overflow: "hidden", background: "var(--surface-primary)" }}>
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
              <Route path="/apply" element={<ApplyYamlPanel />} />
              <Route path="/gitops" element={<GitOpsPanel />} />
              <Route path="/accounts" element={<Padded><AccountsPanel /></Padded>} />
              <Route path="/events" element={<EventsPanel />} />
              <Route path="/assistant" element={<AssistantPanel />} />
              <Route path="/settings" element={<Padded><SettingsPanel /></Padded>} />
            </Routes>
          </main>

          {/* Bottom-mounted terminal drawer — overlays the bottom of the content
              area (above the StatusBar), kept mounted so the shell persists. */}
          <TerminalDrawer open={terminalOpen} onClose={closeTerminal} />
        </div>

        {/* ── ChatPane — right side; toggle with ⌘J. Kept mounted (display:none
            when hidden) so the conversation + live watches persist. ────────── */}
        <div style={{ position: "relative", flexShrink: 0, display: chatHidden ? "none" : "block" }}>
          <ChatPane handleRef={chatHandleRef} />
        </div>

      </div>

      {/* ── StatusBar — full width at the bottom ────────────────────────────── */}
      <StatusBar chatHidden={chatHidden} onToggleChat={toggleChat} />

      {/* Global read-only YAML viewer (opened from any context menu). */}
      <ResourceYamlViewer />
    </div>
  );
}
