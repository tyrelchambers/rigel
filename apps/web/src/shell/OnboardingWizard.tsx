/**
 * First-run setup. Auto-shown after login when no AI agent is connected
 * (dismissible; re-openable from Settings via the "rigel:open-setup" event). A
 * guided front-end over existing flows: connect an AI agent through the real
 * Agents picker, install the Assistant (with a metrics-server nudge when it's
 * missing), import from Docker Compose, and set up notifications. Every step is
 * skippable.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Check, Bot, Activity, Bell, FileInput, X } from "lucide-react";
import {
  useAgents,
  useAssistantAction,
  useNodeMetrics,
  useInstallMetricsServer,
} from "@/lib/api";
import { Stepper } from "./onboarding/Stepper";
import { AgentsTab } from "@/panels/settings/agents/AgentsTab";

export function OnboardingWizard({ onClose, onLeave }: { onClose: () => void; onLeave: () => void }) {
  const navigate = useNavigate();
  const [i, setI] = useState(0);
  const { data: agentsData } = useAgents();
  const activeAgent = agentsData?.agents.find((a) => a.id === agentsData?.activeAgentId);
  const agentConnected = activeAgent?.connection === "connected";

  const steps: { label: string; title?: string; description?: string; status?: ReactNode; node: ReactNode }[] = [
    {
      label: "AI agent",
      title: "Connect your AI agent",
      description:
        "Pick which provider Rigel uses and connect it with an existing subscription or an API key. Your credentials never leave your machine.",
      status: agentConnected ? <StatusPill label="Provider connected" /> : undefined,
      node: <AgentStep />,
    },
    {
      label: "Assistant",
      node: (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <AssistantCard />
          <MetricsNudge />
        </div>
      ),
    },
    {
      label: "Compose",
      node: (
        <ToolCard
          icon={<FileInput size={15} style={{ color: "var(--accent-primary)" }} />}
          title="Coming from Docker Compose?"
          desc="Import your stack. Convert a docker-compose.yml into Kubernetes manifests you can review and apply."
          action={
            <button type="button" onClick={() => { onLeave(); navigate("/compose"); }} style={ghostBtn}>
              Import your stack
            </button>
          }
        />
      ),
    },
    {
      label: "Notifications",
      node: (
        <ToolCard
          icon={<Bell size={15} style={{ color: "var(--accent-primary)" }} />}
          title="Notifications"
          desc="Get cluster alerts where you already are. Connect a channel (Signal today, more coming) from Settings."
          action={
            <button type="button" onClick={() => { onLeave(); navigate("/settings"); }} style={ghostBtn}>
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

  const step = steps[i];

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1 }}>
            <span className="text-xl" style={{ fontWeight: 700, color: "var(--fg-primary)" }}>Welcome to Rigel</span>
            <span className="text-sm" style={{ color: "var(--fg-tertiary)", lineHeight: 1.45 }}>
              A minute of optional setup. Skip anything you don't need. Everything here can be changed later in Settings.
            </span>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} style={closeBtn}>
            <X size={16} />
          </button>
        </div>

        <div style={divider} />

        <div style={stepSection}>
          <Stepper labels={steps.map((s) => s.label)} current={i} status={step.status} />
          {step.title && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span className="text-lg" style={{ fontWeight: 700, color: "var(--fg-primary)" }}>{step.title}</span>
              <span className="text-sm" style={{ color: "var(--fg-secondary)", lineHeight: 1.45 }}>{step.description}</span>
            </div>
          )}
        </div>

        <div style={body}>{step.node}</div>

        <div style={divider} />

        <div style={footer}>
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

function StatusPill({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 11px",
        borderRadius: 999,
        background: "#10B9811A",
        border: "1px solid #10B98140",
      }}
    >
      <Check size={13} style={{ color: "var(--status-running)" }} />
      <span className="text-xs" style={{ fontWeight: 600, color: "var(--status-running)" }}>{label}</span>
    </span>
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
        <span className="text-xs" style={{ fontWeight: 600, color: "var(--fg-primary)" }}>{title}</span>
        <div style={{ flex: 1 }} />
        {action}
      </div>
      <span className="text-xs" style={{ color: "var(--fg-secondary)", lineHeight: 1.5 }}>{desc}</span>
      {children}
    </div>
  );
}

function Done() {
  return (
    <span
      className="text-2xs"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: 999,
        color: "var(--status-running)",
        background: "color-mix(in oklab, var(--status-running) 14%, transparent)",
        border: "1px solid color-mix(in oklab, var(--status-running) 32%, transparent)",
      }}
    >
      <Check size={12} /> Done
    </span>
  );
}

// AI-agent step body: the real pick-and-connect grid, headingless (the step
// title and connection status live in the wizard chrome above the cards).
function AgentStep() {
  return <AgentsTab hideHeading />;
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

// Assistant-step nudge: only when metrics-server is known missing (available === false).
function MetricsNudge() {
  const metrics = useNodeMetrics();
  if (metrics.data?.available !== false) return null;
  return <MetricsCard />;
}

function MetricsCard() {
  const metrics = useNodeMetrics();
  const install = useInstallMetricsServer();
  const available = metrics.data?.available === true;
  return (
    <ToolCard
      icon={<Activity size={15} style={{ color: "var(--accent-primary)" }} />}
      title="metrics-server"
      desc="Enables live node CPU/memory. On homelab clusters the install also adds --kubelet-insecure-tls."
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
  width: "min(720px, 94vw)",
  maxHeight: "88vh",
  overflowY: "auto",
  background: "var(--surface-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
  display: "flex",
  flexDirection: "column",
};
const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  padding: "22px 26px 18px 26px",
  width: "100%",
};
const closeBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: 30,
  height: 30,
  borderRadius: 8,
  background: "#FFFFFF0D",
  border: "none",
  cursor: "pointer",
  color: "var(--fg-secondary)",
};
const divider: React.CSSProperties = { flexShrink: 0, height: 1, width: "100%", background: "var(--border-subtle)" };
const stepSection: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: "18px 26px 4px 26px",
  width: "100%",
};
const body: React.CSSProperties = { padding: "16px 26px", width: "100%" };
const footer: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px 26px 20px 26px",
  width: "100%",
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
  fontSize: 12,
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
