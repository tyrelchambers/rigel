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
import BackupsPanel from "./panels/backups/BackupsPanel";
import RightSizingPanel from "./panels/rightsizing/RightSizingPanel";
import RbacPanel from "./panels/rbac/RbacPanel";
import CertificatesPanel from "./panels/certificates/CertificatesPanel";
import OrdersPanel from "./panels/acme/OrdersPanel";
import ChallengesPanel from "./panels/acme/ChallengesPanel";
import CatalogPanel from "./panels/catalog/CatalogPanel";
import EventsPanel from "./panels/events/EventsPanel";
import LogsPanel from "./panels/logs/LogsPanel";
import AssistantPanel from "./panels/assistant/AssistantPanel";
import SettingsPanel from "./panels/settings/SettingsPanel";
import AccountsPanel from "./panels/accounts/AccountsPanel";
import ApplyYamlPanel from "./panels/apply/ApplyYamlPanel";
import ComposeMigratePanel from "./panels/compose/ComposeMigratePanel";
import GitOpsPanel from "./panels/gitops/GitOpsPanel";
import HelmPanel from "./panels/helm/HelmPanel";
import PluginsPanel from "./panels/plugins/PluginsPanel";
import FailoverPanel from "./panels/failover/FailoverPanel";
import { FailoverBanner } from "./shell/FailoverBanner";
import { TerminalDrawer, TOGGLE_TERMINAL_EVENT } from "@/shell/TerminalDrawer";
import { ResourceYamlViewer } from "@/components/ResourceYamlViewer";
import { Toaster } from "@/components/ui/sonner";
import { connectCluster } from "@/lib/ws";
import { useContexts } from "@/lib/api";
import { shouldAutoOpenOnboarding } from "@/shell/onboarding/shouldAutoOpen";
import { OnboardingWizard } from "@/shell/OnboardingWizard";
import { ClusterRail } from "@/shell/ClusterRail";
import StatusBar from "@/shell/StatusBar";
import ChatPane, { type ChatPaneHandle } from "@/shell/ChatPane";
import { CommandPalette, useCommandPalette } from "@/shell/CommandPalette";
import { NavLauncher, useNavLauncher } from "@/shell/NavLauncher";
import { GlobalHeader } from "@/shell/GlobalHeader";
import { WindowControls } from "@/shell/WindowControls";
import { AccountModal } from "@/shell/AccountModal";
import { UpgradeProvider } from "@/shell/UpgradeContext";
import { useAccount, type UseAccountResult } from "@/shell/useAccount";
import { registerChatReveal } from "@/lib/chatHandoff";
import { useCommand, useShortcutDispatch } from "@/lib/shortcuts/useCommand";

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
  const account = useAccount();

  if (account.status === "loading") {
    return <div style={{ height: "100vh", background: "var(--surface-sunken)" }} />;
  }

  // Signed out is a normal, fully usable state: sign-in is the last onboarding
  // step and can be skipped. Features that need an account prompt in place.
  return <AppContent account={account} />;
}

function AppContent({ account }: { account: UseAccountResult }) {
  useEffect(() => {
    connectCluster();
  }, []);
  useShortcutDispatch();
  const [paletteOpen, setPaletteOpen] = useCommandPalette();

  const [launcherOpen, setLauncherOpen] = useNavLauncher();

  // First-run onboarding: auto-show until finished and a cluster is attached;
  // re-openable from Settings via an event.
  const { data: contexts } = useContexts();
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Account modal — session state (sign-in/out) is owned by useAccount.
  const [accountOpen, setAccountOpen] = useState(false);
  const [upgradeIntent, setUpgradeIntent] = useState(false);
  const openUpgrade = useCallback(() => {
    setAccountOpen(true);
    setUpgradeIntent(true);
  }, []);

  useEffect(() => {
    const open = () => setShowOnboarding(true);
    window.addEventListener("rigel:open-setup", open);
    return () => window.removeEventListener("rigel:open-setup", open);
  }, []);

  // Suppresses auto-open once onboarding has been closed or left this session, so
  // a contexts refetch can't pop the wizard back over a panel the user navigated to.
  const onboardingHandledRef = useRef(false);
  useEffect(() => {
    if (onboardingHandledRef.current) return;
    if (
      shouldAutoOpenOnboarding({
        contexts,
        onboarded: localStorage.getItem("rigel_onboarded") !== null,
      })
    ) {
      setShowOnboarding(true);
    }
  }, [contexts]);
  function closeOnboarding() {
    onboardingHandledRef.current = true;
    setShowOnboarding(false);
    localStorage.setItem("rigel_onboarded", "1");
  }
  // Leaving onboarding to go use a real feature (Compose, Settings) closes the
  // wizard but does NOT mark setup complete, so it stays reopenable from Settings.
  function leaveOnboarding() {
    onboardingHandledRef.current = true;
    setShowOnboarding(false);
  }

  // The ChatPane exposes a send() handle so OverviewPanel's
  // "Investigate cluster" button can inject a message.
  const chatHandleRef = useRef<ChatPaneHandle | null>(null);

  function handleInvestigateCluster() {
    chatHandleRef.current?.send(
      "Investigate the cluster's current health. Run kubectl read-only commands across nodes, pods, recent events, deployment status, and CNPG cluster health. Identify anything broken, broken-soon, or unusual. Be concise. Group findings by severity. If everything looks fine, say so briefly."
    );
  }

  // Chat-pane visibility — persisted across reloads.
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
  useCommand("chat.toggle", toggleChat);

  // Terminal drawer — bottom-mounted persistent shell. Toggled from the
  // StatusBar chip / nav item / command palette via the shared event. Kept
  // mounted so the PTY + scrollback survive hide/show.
  const [terminalOpen, setTerminalOpen] = useState<boolean>(readTerminalOpen);
  const toggleTerminal = useCallback(() => setTerminalOpen((o) => { persistTerminalOpen(!o); return !o; }), []);
  const closeTerminal = useCallback(() => { persistTerminalOpen(false); setTerminalOpen(false); }, []);
  useCommand("terminal.toggle", toggleTerminal);
  useEffect(() => {
    window.addEventListener(TOGGLE_TERMINAL_EVENT, toggleTerminal);
    return () => window.removeEventListener(TOGGLE_TERMINAL_EVENT, toggleTerminal);
  }, [toggleTerminal]);

  return (
    <UpgradeProvider onUpgrade={openUpgrade}>
    <WindowControls />
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--surface-primary)" }}>
      {showOnboarding && <OnboardingWizard account={account} onClose={closeOnboarding} onLeave={leaveOnboarding} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <NavLauncher open={launcherOpen} onClose={() => setLauncherOpen(false)} />
      <AccountModal
        open={accountOpen}
        onOpenChange={(o) => { setAccountOpen(o); if (!o) setUpgradeIntent(false); }}
        account={account}
        startCheckoutOnOpen={upgradeIntent}
      />

      {/* ── Global header — full-width bar across the top of the window. ─────── */}
      <GlobalHeader
        onOpenSearch={() => setPaletteOpen(true)}
        onOpenAccount={() => setAccountOpen(true)}
      />
      <FailoverBanner />

      {/* ── Body row (below the header): cluster rail + nav + content + chat. ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* ── Cluster rail — far left, Discord-style. Both navs sit under the
            full-width header now. ──────────────────────────────────────────── */}
        <ClusterRail launcherOpen={launcherOpen} onToggleLauncher={() => setLauncherOpen(!launcherOpen)} />

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
              <Route path="/backups" element={<BackupsPanel />} />
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
              <Route path="/orders" element={<OrdersPanel />} />
              <Route path="/challenges" element={<ChallengesPanel />} />
              <Route path="/catalog" element={<PaddedX><CatalogPanel /></PaddedX>} />
              <Route path="/helm" element={<HelmPanel />} />
              <Route path="/plugins" element={<PluginsPanel />} />
              <Route path="/apply" element={<ApplyYamlPanel />} />
              <Route path="/compose" element={<ComposeMigratePanel />} />
              <Route path="/failover" element={<FailoverPanel />} />
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

      </div>{/* end body row */}

      {/* ── StatusBar — full-width footer across the bottom of the window. ──── */}
      <StatusBar chatHidden={chatHidden} onToggleChat={toggleChat} />

      {/* Global read-only YAML viewer (opened from any context menu). */}
      <ResourceYamlViewer />

      {/* Toast host — background action progress (see lib/actionRunner). */}
      <Toaster />
    </div>
    </UpgradeProvider>
  );
}
