/**
 * First-run setup. Auto-shown after login when no Claude token is configured
 * (dismissible; re-openable from Settings via the "helmsman:open-setup" event).
 * A guided front-end over existing endpoints — captures the Claude token and
 * offers one-click installs of the Assistant, metrics-server, and Signal.
 */
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Sparkles, Check, Bot, Activity, Bell } from "lucide-react";
import {
  useChatConfig,
  useSetChatToken,
  useAssistantAction,
  useNodeMetrics,
  useInstallMetricsServer,
} from "@/lib/api";

export function OnboardingWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <div style={overlay}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Sparkles size={18} style={{ color: "#A855F7" }} />
          <span style={{ fontSize: 17, fontWeight: 600, color: "#FFFFFF" }}>Welcome to Helmsman</span>
        </div>
        <span style={{ fontSize: 12.5, color: "#A1A1AA", lineHeight: 1.5 }}>
          A minute of optional setup. Everything here can also be changed later in Settings — skip
          anything you don't need.
        </span>

        <TokenCard />
        <AssistantCard />
        <MetricsCard />
        <ToolCard
          icon={<Bell size={15} style={{ color: "#A855F7" }} />}
          title="Signal notifications"
          desc="Get cluster alerts on your phone. The linking flow (QR scan) lives in Settings."
          action={
            <button type="button" onClick={() => { onClose(); navigate("/settings"); }} style={ghostBtn}>
              Set up in Settings
            </button>
          }
        />

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <button type="button" onClick={onClose} style={primaryBtn}>Done</button>
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
        <span style={{ fontSize: 13, fontWeight: 600, color: "#FFFFFF" }}>{title}</span>
        <div style={{ flex: 1 }} />
        {action}
      </div>
      <span style={{ fontSize: 12, color: "#A1A1AA", lineHeight: 1.5 }}>{desc}</span>
      {children}
    </div>
  );
}

function Done() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "#10B981" }}>
      <Check size={13} /> Done
    </span>
  );
}

function TokenCard() {
  const { data: config } = useChatConfig();
  const setToken = useSetChatToken();
  const [token, setTokenInput] = useState("");
  const configured = config?.configured ?? false;

  return (
    <ToolCard
      icon={<Sparkles size={15} style={{ color: "#A855F7" }} />}
      title="AI copilot (the Helmsman)"
      desc="Chat needs a Claude subscription token — run `claude setup-token` and paste the sk-ant-oat-… value."
      action={configured ? <Done /> : undefined}
    >
      {!configured && (
        <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
          <input
            type="password"
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="sk-ant-oat-…"
            style={input}
          />
          <button
            type="button"
            disabled={!token.trim() || setToken.isPending}
            onClick={() => setToken.mutate(token.trim())}
            style={{ ...ghostBtn, opacity: !token.trim() || setToken.isPending ? 0.6 : 1 }}
          >
            {setToken.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </ToolCard>
  );
}

function AssistantCard() {
  const install = useAssistantAction();
  return (
    <ToolCard
      icon={<Bot size={15} style={{ color: "#A855F7" }} />}
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
      icon={<Activity size={15} style={{ color: "#A855F7" }} />}
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
  background: "#141417",
  border: "1px solid #2A2A2A",
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
  background: "#0A0A0C",
  border: "1px solid #26262C",
  borderRadius: 10,
};
const input: React.CSSProperties = {
  flex: 1,
  padding: "7px 10px",
  borderRadius: 7,
  background: "#0A0A0C",
  border: "1px solid #2A2A2A",
  color: "#FFFFFF",
  fontSize: 12,
  fontFamily: "ui-monospace, monospace",
  outline: "none",
};
const primaryBtn: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  background: "#A855F7",
  color: "#FFFFFF",
  fontSize: 12.5,
  fontWeight: 500,
  border: "none",
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 7,
  background: "#1C1C22",
  color: "#FFFFFF",
  fontSize: 12,
  fontWeight: 500,
  border: "1px solid #2A2A2A",
  cursor: "pointer",
};
const errText: React.CSSProperties = { fontSize: 11, color: "#EF4444" };
