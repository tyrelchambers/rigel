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
import HelmPanel from "./panels/helm/HelmPanel";
import { TerminalDrawer, TOGGLE_TERMINAL_EVENT } from "@/shell/TerminalDrawer";
import { ResourceYamlViewer } from "@/components/ResourceYamlViewer";
import { Toaster } from "@/components/ui/sonner";
import { connectCluster } from "@/lib/ws";
import { useChatConfig } from "@/lib/api";
import { rigel } from "@/lib/desktop";
import { OnboardingWizard } from "@/shell/OnboardingWizard";
import { AccountGate } from "@/shell/AccountGate";
import NavStrip from "@/shell/NavStrip";
import { ClusterRail } from "@/shell/ClusterRail";
import StatusBar from "@/shell/StatusBar";
import ChatPane, { type ChatPaneHandle } from "@/shell/ChatPane";
import { CommandPalette, useCommandPalette } from "@/shell/CommandPalette";
import { GlobalHeader } from "@/shell/GlobalHeader";
import { AccountModal } from "@/shell/AccountModal";
import { loadSidebarCollapsed, saveSidebarCollapsed } from "@/shell/navCollapse";
import { registerChatReveal } from "@/lib/chatHandoff";

function readTerminalOpen(): boolean {
  try { return localStorage.getItem("rigel.terminal.open") === "1"; } catch { return false; }
}
function persistTerminalOpen(open: boolean): void {
  try { localStorage.setItem("rigel.terminal.open", open ? "1" : "0"); } catch { /* ignore */ }
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
  // Name/email capture is handled earlier by the full-screen AccountGate below.
  const { data: chatConfig } = useChatConfig();
  const [showOnboarding, setShowOnboarding] = useState(false);
  // First-run gate: the app does not render until name+email exist. `null` =
  // still checking (desktop); off-desktop there's no bridge, so no gate.
  const [accountMissing, setAccountMissing] = useState<boolean | null>(rigel ? null : false);

  // Account modal — refetch the captured name/email each time the modal opens,
  // so it reflects a profile written during this session (e.g. right after the
  // first-run signup), not just whatever existed at mount. `rigel` is undefined
  // off-desktop; the method itself is always present on a real bridge.
  const [accountOpen, setAccountOpen] = useState(false);
  const [account, setAccount] = useState<{ name: string; email: string } | null>(null);
  useEffect(() => {
    if (!accountOpen) return;
    let cancelled = false;
    rigel
      ?.getSignupData()
      .then((d) => { if (!cancelled) setAccount(d); })
      .catch(() => { if (!cancelled) setAccount(null); });
    return () => { cancelled = true; };
  }, [accountOpen]);

  useEffect(() => {
    const open = () => setShowOnboarding(true);
    window.addEventListener("rigel:open-setup", open);
    return () => window.removeEventListener("rigel:open-setup", open);
  }, []);
  useEffect(() => {
    if (!rigel) return; // off-desktop: no gate (accountMissing starts false)
    let cancelled = false;
    rigel
      .getSignupData()
      .then((p) => { if (!cancelled) setAccountMissing(!p || !p.name || !p.email); })
      .catch(() => { if (!cancelled) setAccountMissing(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (accountMissing !== false) return; // hold optional onboarding until the gate clears
    if (chatConfig && !chatConfig.configured && !localStorage.getItem("rigel_onboarded")) {
      setShowOnboarding(true);
    }
  }, [chatConfig, accountMissing]);
  function closeOnboarding() {
    setShowOnboarding(false);
    localStorage.setItem("rigel_onboarded", "1");
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
      return localStorage.getItem("rigel.chat.hidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleChat = useCallback(() => {
    setChatHidden((h) => {
      const next = !h;
      try {
        localStorage.setItem("rigel.chat.hidden", next ? "1" : "0");
      } catch {
        /* ignore quota / private-browsing errors */
      }
      return next;
    });
  }, []);
  // Let a new-thread chat handoff un-hide a collapsed chat pane.
  useEffect(() => {
    registerChatReveal(() => {
      setChatHidden(false);
      try {
        localStorage.setItem("rigel.chat.hidden", "0");
      } catch {
        /* ignore quota / private-browsing errors */
      }
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

  if (accountMissing === null) {
    return <div style={{ height: "100vh", background: "var(--surface-primary)" }} />;
  }
  if (accountMissing) {
    return <AccountGate onDone={() => setAccountMissing(false)} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "row", height: "100vh", background: "var(--surface-primary)" }}>
      {showOnboarding && <OnboardingWizard onClose={closeOnboarding} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <AccountModal
        open={accountOpen}
        onOpenChange={setAccountOpen}
        name={account?.name}
        email={account?.email}
      />

      {/* ── Cluster rail — far left, FULL window height (top of the window to
          the bottom), Discord-style: the whole app lives to the right of it. ─ */}
      <ClusterRail />

      {/* Everything right of the rail — header, main row, status bar — stacked. */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, height: "100%" }}>

        {/* ── Global header — slim bar above the content (right of the rail) ── */}
        <GlobalHeader
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onOpenSearch={() => setPaletteOpen(true)}
          onOpenAccount={() => setAccountOpen(true)}
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
              <Route path="/helm" element={<HelmPanel />} />
              <Route path="/apply" element={<ApplyYamlPanel />} />
              <Route path="/gitops" element={<GitOpsPanel />} />
              <Route path="/accounts" element={<Padded><AccountsPanel /></Padded>} />
              <Route path="/settings" element={<Padded><SettingsPanel /></Padded>} />
              <Route path="/events" element={<EventsPanel />} />
              <Route path="/assistant" element={<AssistantPanel />} />
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

        {/* ── StatusBar — bottom of the content column (right of the rail) ──── */}
        <StatusBar chatHidden={chatHidden} onToggleChat={toggleChat} />
      </div>{/* end content column — everything to the right of the cluster rail */}

      {/* Global read-only YAML viewer (opened from any context menu). */}
      <ResourceYamlViewer />

      {/* Toast host — background action progress (see lib/actionRunner). */}
      <Toaster />
    </div>
  );
}
