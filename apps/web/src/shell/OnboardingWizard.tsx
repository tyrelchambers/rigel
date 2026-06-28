/**
 * First-run setup. Auto-shown after login when no AI agent is connected
 * (dismissible; re-openable from Settings via the "rigel:open-setup" event). A
 * guided front-end over existing flows: connect an AI agent through the real
 * Agents picker, and offer one-click installs of the Assistant, metrics-server,
 * and Signal. Every step is skippable.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Sparkles, Check, Bot, Activity, Bell } from "lucide-react";
import {
  useAgents,
  useAssistantAction,
  useNodeMetrics,
  useInstallMetricsServer,
} from "@/lib/api";
import { Stepper } from "./onboarding/Stepper";
import { AgentsTab } from "@/panels/settings/agents/AgentsTab";

export function OnboardingWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [i, setI] = useState(0);

  const steps: { label: string; node: ReactNode }[] = [
    { label: "AI agent", node: <AgentStep /> },
    { label: "Assistant", node: <AssistantCard /> },
    { label: "Metrics", node: <MetricsCard /> },
    {
      label: "Notifications",
      node: (
        <ToolCard
          icon={<Bell size={15} style={{ color: "var(--accent-primary)" }} />}
          title="Signal notifications"
          desc="Get cluster alerts on your phone. The linking flow (QR scan) lives in Settings."
          action={
            <button type="button" onClick={() => { onClose(); navigate("/settings"); }} style={ghostBtn}>
              Set up in Settings
            </button>
          }
        />
      ),
    },
  ];

  const isFirst = i === 0;
  const isLast = i === steps.length - 1;

  // Enter advances to the next step (or finishes on the last). It yields to the
  // focused control so it never discards typed input or double-fires: a focused
  // input/textarea/button/link handles Enter itself.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.isComposing) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "A") return;
      e.preventDefault();
      if (isLast) onClose();
      else setI((n) => n + 1);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isLast, onClose]);

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Sparkles size={18} style={{ color: "var(--accent-primary)" }} />
          <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-primary)" }}>Welcome to Rigel</span>
        </div>

        <span style={{ fontSize: 12.5, color: "var(--fg-secondary)", lineHeight: 1.5 }}>
          A minute of optional setup. Everything here can also be changed later in Settings. Skip
          anything you don't need.
        </span>

        <Stepper labels={steps.map((s) => s.label)} current={i} />

        {steps[i].node}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
          <div>
            {!isFirst && (
              <button type="button" onClick={() => setI((n) => n - 1)} style={ghostBtn}>
                Back
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {!isLast && (
              <button type="button" onClick={() => setI((n) => n + 1)} style={ghostBtn}>
                Skip
              </button>
            )}
            {isLast ? (
              <button type="button" onClick={onClose} style={primaryBtn}>Done</button>
            ) : (
              <button type="button" onClick={() => setI((n) => n + 1)} style={primaryBtn}>Next →</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolCard({
  icon,
  title,
  desc,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div style={tool}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {icon}
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-primary)" }}>{title}</span>
        <div style={{ flex: 1 }} />
        {action}
      </div>
      <span style={{ fontSize: 12, color: "var(--fg-secondary)", lineHeight: 1.5 }}>{desc}</span>
      {children}
    </div>
  );
}

function Done() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--status-running)" }}>
      <Check size={13} /> Done
    </span>
  );
}

/**
 * AI-agent setup step. Renders the real pick-and-connect flow (AgentsTab: the
 * same grid of agents + per-agent auth used in Settings, then Agents) so
 * onboarding connects an agent through the proper multi-agent path instead of
 * saving a single Claude token. Completion mirrors ChatPane: the step is "Done"
 * once the ACTIVE agent reports connected. The step is skippable — chat's
 * empty-state guides anyone who continues without connecting.
 */
function AgentStep() {
  const { data } = useAgents();
  const activeAgent = data?.agents.find((a) => a.id === data?.activeAgentId);
  const connected = activeAgent?.connection === "connected";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12.5, color: "var(--fg-secondary)", lineHeight: 1.5, flex: 1 }}>
          Pick the AI agent Rigel should use and connect it. You can change this any time in Settings, then Agents.
        </span>
        {connected && <Done />}
      </div>
      {/* The real Agents flow: grid → per-agent auth, with its own "Connect your
          AI agent" heading. No settings chrome, so it embeds directly. */}
      <AgentsTab />
    </div>
  );
}

function AssistantCard() {
  const install = useAssistantAction();
  return (
    <ToolCard
      icon={<Bot size={15} style={{ color: "var(--accent-primary)" }} />}
      title="Assistant agent"
      desc="An in-cluster agent that watches for problems and proposes remediations. Optional."
      action={
        install.isSuccess ? (
          <Done />
        ) : (
          <button
            type="button"
            disabled={install.isPending}
            onClick={() => install.mutate({ action: "install" })}
            style={{ ...ghostBtn, opacity: install.isPending ? 0.6 : 1 }}
          >
            {install.isPending ? "Installing…" : "Install"}
          </button>
        )
      }
    >
      {install.isError && <span style={errText}>{install.error.message}</span>}
    </ToolCard>
  );
}

function MetricsCard() {
  const metrics = useNodeMetrics();
  const install = useInstallMetricsServer();
  const available = metrics.data?.available === true;
  return (
    <ToolCard
      icon={<Activity size={15} style={{ color: "var(--accent-primary)" }} />}
      title="metrics-server"
      desc="Enables live CPU/memory and Right-sizing. On homelab clusters the install also adds --kubelet-insecure-tls."
      action={
        available || install.isSuccess ? (
          <Done />
        ) : (
          <button
            type="button"
            disabled={install.isPending}
            onClick={() => install.mutate()}
            style={{ ...ghostBtn, opacity: install.isPending ? 0.6 : 1 }}
          >
            {install.isPending ? "Installing…" : "Install"}
          </button>
        )
      }
    >
      {install.isError && <span style={errText}>{install.error.message}</span>}
    </ToolCard>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 80,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};
const card: React.CSSProperties = {
  width: "min(560px, 96vw)",
  maxHeight: "88vh",
  overflowY: "auto",
  background: "var(--surface-elevated)",
  border: "1px solid #34353A",
  borderRadius: 14,
  boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
  padding: 22,
  display: "flex",
  flexDirection: "column",
  gap: 14,
};
const tool: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 14,
  background: "var(--surface-sunken)",
  border: "1px solid #26272B",
  borderRadius: 10,
};
const primaryBtn: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  background: "var(--accent-primary)",
  color: "var(--fg-inverse)",
  fontSize: 12.5,
  fontWeight: 500,
  border: "none",
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 7,
  background: "var(--surface-elevated)",
  color: "var(--fg-primary)",
  fontSize: 12,
  fontWeight: 500,
  border: "1px solid #34353A",
  cursor: "pointer",
};
const errText: React.CSSProperties = { fontSize: 11, color: "var(--status-failed)" };
