/**
 * First-run setup. The single onboarding surface: connect a cluster, connect an
 * AI agent (with the optional in-cluster installs), then leave an email for a
 * sign-in link. Every step is skippable, and nothing here blocks the app.
 */
import { useEffect, useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faRobot, faWaveform, faXmark } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useAssistantAction, useNodeMetrics, useInstallMetricsServer } from "@/lib/api";
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

  const steps: { label: string; title?: string; description?: string; node: ReactNode }[] = [
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
      node: (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <AgentsTab hideHeading />
          <OptionalRow />
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

        {step.title && (
          <div style={stepSection}>
            <span className="text-lg" style={{ fontWeight: 700, color: "var(--fg-primary)" }}>{step.title}</span>
            <span className="text-sm" style={{ color: "var(--fg-secondary)", lineHeight: 1.45 }}>{step.description}</span>
          </div>
        )}

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
            <button type="button" onClick={() => (isLast ? onClose() : setI((n) => n + 1))} style={ghostBtn}>
              Skip
            </button>
            {!isLast && (
              <button type="button" onClick={() => setI((n) => n + 1)} style={primaryBtn}>Next →</button>
            )}
            {isLast && (
              <button type="button" onClick={onClose} style={primaryBtn}>Done</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The two optional in-cluster installs, one bordered card, two rows. */
function OptionalRow() {
  const metrics = useNodeMetrics();
  const showMetrics = metrics.data?.available === false;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="text-3xs" style={{ fontFamily: "var(--font-mono)", letterSpacing: 1.2, color: "var(--fg-tertiary)" }}>
        OPTIONAL
      </span>
      <div style={tool}>
        <AssistantInstall />
        {showMetrics && (
          <>
            <div style={{ height: 1, background: "#FFFFFF0A" }} />
            <MetricsInstall />
          </>
        )}
      </div>
    </div>
  );
}

function InstallRow({
  icon,
  title,
  desc,
  done,
  pending,
  error,
  onInstall,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  done: boolean;
  pending: boolean;
  error: string | null;
  onInstall: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {icon}
        <span className="text-xs" style={{ fontWeight: 600, color: "var(--fg-primary)" }}>{title}</span>
        <div style={{ flex: 1 }} />
        {done ? (
          <span className="text-2xs" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 600, color: "var(--status-running)" }}>
            <FontAwesomeIcon icon={faCheck} className="size-[12px]" /> Done
          </span>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={onInstall}
            style={{ ...ghostBtn, opacity: pending ? 0.6 : 1 }}
          >
            {pending ? "Installing…" : "Install"}
          </button>
        )}
      </div>
      <span className="text-xs" style={{ color: "var(--fg-secondary)", lineHeight: 1.45 }}>{desc}</span>
      {error && <span style={errText}>{error}</span>}
    </div>
  );
}

function AssistantInstall() {
  const install = useAssistantAction();
  return (
    <InstallRow
      icon={<FontAwesomeIcon icon={faRobot} className="size-[15px]" style={{ color: "var(--accent-primary)" }} />}
      title="Assistant agent"
      desc="An in-cluster agent that watches for problems and proposes remediations."
      done={install.isSuccess}
      pending={install.isPending}
      error={install.isError ? install.error.message : null}
      onInstall={() => install.mutate({ action: "install" })}
    />
  );
}

function MetricsInstall() {
  const install = useInstallMetricsServer();
  return (
    <InstallRow
      icon={<FontAwesomeIcon icon={faWaveform} className="size-[15px]" style={{ color: "var(--accent-primary)" }} />}
      title="metrics-server"
      desc="Enables live node CPU and memory. On homelab clusters the install also adds --kubelet-insecure-tls."
      done={install.isSuccess}
      pending={install.isPending}
      error={install.isError ? install.error.message : null}
      onInstall={() => install.mutate()}
    />
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
const errText: React.CSSProperties = { fontSize: 11, color: "var(--status-failed)" };
