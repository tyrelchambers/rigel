/**
 * First-run setup. The single onboarding surface: connect a cluster, connect an
 * AI agent (with the optional in-cluster installs), then leave an email for a
 * sign-in link. Every step is skippable, and nothing here blocks the app.
 */
import { useEffect, useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faRobot, faWaveform, faXmark } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useAgents, useAssistantAction, useNodeMetrics, useInstallMetricsServer } from "@/lib/api";
import { Stepper } from "./onboarding/Stepper";
import { ClusterStep } from "./onboarding/ClusterStep";
import { AgentsTab } from "@/panels/settings/agents/AgentsTab";
import { SignInFlow } from "./SignInFlow";
import type { UseAccountResult } from "./useAccount";

export function OnboardingWizard({
  account,
  onClose,
  onLeave,
}: {
  account: UseAccountResult;
  onClose: () => void;
  onLeave: () => void;
}) {
  const [i, setI] = useState(0);
  const { data: agentsData } = useAgents();
  const activeAgent = agentsData?.agents.find((a) => a.id === agentsData?.activeAgentId);
  const agentConnected = activeAgent?.connection === "connected";

  const steps: { label: string; title: string; description: string; status?: ReactNode; node: ReactNode }[] = [
    {
      label: "Cluster",
      title: "Connect a cluster",
      description:
        "Rigel works with any Kubernetes cluster. Pick how you want to connect, and you can add more later from the cluster rail.",
      node: <ClusterStep />,
    },
    {
      label: "AI agent",
      title: "Connect your AI agent",
      description:
        "Pick which provider Rigel uses and connect it with an existing subscription or an API key. Your credentials never leave your machine.",
      status: agentConnected ? <StatusPill label="Provider connected" /> : undefined,
      node: (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <AgentsTab hideHeading />
          <OptionalInstalls />
        </div>
      ),
    },
    {
      label: "Email",
      title: "Sign in to Rigel",
      description:
        "Enter your email and we'll send you a sign-in link. Open it whenever you like and Rigel signs itself in, even if you're already busy in the app.",
      node: <SignInFlow account={account} hideHeading />,
    },
  ];

  const isFirst = i === 0;
  const isLast = i === steps.length - 1;

  // Enter advances to the next step. It yields to the focused control so it
  // never discards typed input or double-fires: a focused input/textarea/
  // button/link handles Enter itself. It never FINISHES, because finishing
  // writes the onboarded flag and first run would not come back on its own.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.isComposing) return;
      if (isLast) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "A") return;
      e.preventDefault();
      setI((n) => n + 1);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isLast]);

  const step = steps[i];

  return (
    // No click-outside-to-close: a stray click on the scrim must not dismiss
    // first-run setup. The X and the footer buttons are the ways out.
    <div style={overlay}>
      <div style={card}>
        <div style={header}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1 }}>
            <span className="text-xl" style={{ fontWeight: 700, color: "var(--fg-primary)" }}>Welcome to Rigel</span>
            <span className="text-sm" style={{ color: "var(--fg-tertiary)", lineHeight: 1.45 }}>
              A minute of optional setup. Skip anything you don't need. Everything here can be changed later in Settings.
            </span>
          </div>
          <button type="button" aria-label="Close" onClick={onLeave} style={closeBtn}>
            <FontAwesomeIcon icon={faXmark} className="size-[16px]" />
          </button>
        </div>

        <Stepper labels={steps.map((s) => s.label)} current={i} />

        <div style={stepSection}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span className="text-lg" style={{ fontWeight: 700, color: "var(--fg-primary)" }}>{step.title}</span>
            {step.status}
          </div>
          <span className="text-sm" style={{ color: "var(--fg-secondary)", lineHeight: 1.45 }}>{step.description}</span>
        </div>

        {/* Every body stays mounted (hidden via display:none) so a typed email,
            an in-flight install, or a half-finished connect flow survives
            stepping away and back. Only the chrome above tracks the step. */}
        {steps.map((s, n) => (
          <div key={s.label} style={{ ...body, display: n === i ? undefined : "none" }}>
            {s.node}
          </div>
        ))}

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
            <button type="button" onClick={() => (isLast ? onClose() : setI((n) => n + 1))} style={ghostBtn}>
              Skip
            </button>
            {!isLast && (
              <button type="button" onClick={() => setI((n) => n + 1)} style={primaryBtn}>Next →</button>
            )}
            {/* One primary at a time. Until a sign-in is pending, SignInFlow's
                own "Send sign-in link" is the primary, so the footer offers no
                competing one: finishing here would set the onboarded flag with
                nothing captured. Once the link is sent, SignInFlow drops to a
                ghost "Send it again" and Done becomes the only primary. */}
            {isLast && account.pendingSignIn != null && (
              <button type="button" onClick={onClose} style={primaryBtn}>Done</button>
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
      <FontAwesomeIcon icon={faCheck} className="size-[13px]" style={{ color: "var(--status-running)" }} />
      <span className="text-xs" style={{ fontWeight: 600, color: "var(--status-running)" }}>{label}</span>
    </span>
  );
}

/** The two optional in-cluster installs: a captioned section wrapping one
 *  bordered card of rows. metrics-server only appears when the cluster is known
 *  to be missing it. */
function OptionalInstalls() {
  const metrics = useNodeMetrics();
  const assistant = useAssistantAction();
  const metricsServer = useInstallMetricsServer();
  const showMetrics = metrics.data?.available === false;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="text-3xs" style={{ fontFamily: "var(--font-mono)", letterSpacing: 1.2, color: "var(--fg-tertiary)" }}>
        OPTIONAL
      </span>
      <div style={tool}>
        <InstallRow
          icon={<FontAwesomeIcon icon={faRobot} className="size-[15px]" style={{ color: "var(--accent-primary)" }} />}
          title="Assistant agent"
          desc="An in-cluster agent that watches for problems and proposes remediations."
          install={assistant}
          onInstall={() => assistant.mutate({ action: "install" })}
        />
        {showMetrics && (
          <>
            <div style={hairline} />
            <InstallRow
              icon={<FontAwesomeIcon icon={faWaveform} className="size-[15px]" style={{ color: "var(--accent-primary)" }} />}
              title="metrics-server"
              desc="Enables live node CPU and memory. On homelab clusters the install also adds --kubelet-insecure-tls."
              install={metricsServer}
              onInstall={() => metricsServer.mutate()}
            />
          </>
        )}
      </div>
    </div>
  );
}

interface InstallState {
  isSuccess: boolean;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
}

function InstallRow({
  icon,
  title,
  desc,
  install,
  onInstall,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  install: InstallState;
  onInstall: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {icon}
        <span className="text-xs" style={{ fontWeight: 600, color: "var(--fg-primary)" }}>{title}</span>
        <div style={{ flex: 1 }} />
        {install.isSuccess ? (
          <span className="text-2xs" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 600, color: "var(--status-running)" }}>
            <FontAwesomeIcon icon={faCheck} className="size-[12px]" /> Done
          </span>
        ) : (
          <button
            type="button"
            disabled={install.isPending}
            onClick={onInstall}
            style={{ ...ghostBtn, opacity: install.isPending ? 0.6 : 1 }}
          >
            {install.isPending ? "Installing…" : "Install"}
          </button>
        )}
      </div>
      <span className="text-xs" style={{ color: "var(--fg-secondary)", lineHeight: 1.45 }}>{desc}</span>
      {install.isError && <span style={errText}>{install.error?.message}</span>}
    </div>
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
  gap: 5,
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
const hairline: React.CSSProperties = {
  height: 1,
  background: "color-mix(in oklab, var(--border-subtle) 55%, transparent)",
};
const errText: React.CSSProperties = { fontSize: 11, color: "var(--status-failed)" };
