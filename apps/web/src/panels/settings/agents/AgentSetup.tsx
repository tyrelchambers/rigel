import { useState, type ReactNode } from "react";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { useSetAgentAuth, type AgentAuthMethod, type AgentView } from "@/lib/api";
import { AgentGlyph } from "./agentGlyphs";

const MUTED = "#8C8C95";
const ACCENT = "#3B9BE8";

const METHOD_COPY: Record<AgentAuthMethod, { title: string; sub: (vendor: string) => string }> = {
  subscription: {
    title: "Your existing CLI login",
    sub: (v) => `Use your current ${v} subscription session.`,
  },
  apiKey: {
    title: "API key",
    sub: (v) => `Paste your ${v} API key instead.`,
  },
};

export function AgentSetup({ agent, onBack }: { agent: AgentView; onBack: () => void }) {
  const comingSoon = agent.status === "comingSoon";
  const save = useSetAgentAuth();
  const [method, setMethod] = useState<AgentAuthMethod>(agent.authMethod);
  const [secret, setSecret] = useState("");

  const needsSecret = method === "apiKey";
  const saveDisabled = comingSoon || save.isPending || (needsSecret && !secret.trim());

  async function onSave() {
    await save.mutateAsync({ id: agent.id, authMethod: method, secret: secret.trim() });
    setSecret("");
  }

  return (
    <div className="flex flex-col" style={{ gap: 22 }}>
      {/* Back */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center self-start transition-opacity hover:opacity-80"
        style={{ gap: 7, fontSize: 16, fontWeight: 500, color: MUTED }}
      >
        <ChevronLeft size={18} /> Back
      </button>

      {/* Header: mark + name + status pill, then the vendor line */}
      <div className="flex flex-col" style={{ gap: 8 }}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center" style={{ gap: 12, color: "#FFFFFF" }}>
            <AgentGlyph id={agent.id} size={26} />
            <span style={{ fontSize: 28, fontWeight: 700, color: "#FFFFFF" }}>{agent.label}</span>
          </div>
          <StatusPill connection={agent.connection} comingSoon={comingSoon} />
        </div>
        <p style={{ fontSize: 15, color: MUTED }}>
          {agent.vendor} · Credentials stay local and are never uploaded.
        </p>
      </div>

      {/* Step 1 — Install */}
      <StepCard n={1} heading={`Install ${agent.label}`} desc={`Install the ${agent.label} CLI on this machine if you haven't already.`}>
        <a
          href={agent.installUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center self-start rounded-[9px] border border-white/[0.08] transition-colors hover:bg-white/[0.04]"
          style={{ gap: 8, padding: "10px 16px", fontSize: 14, fontWeight: 600, color: "#4FB0F2" }}
        >
          {agent.installLabel}
          <ExternalLink size={15} />
        </a>
      </StepCard>

      {/* Step 2 — Authenticate */}
      <StepCard n={2} heading="Authenticate" desc={`Choose how Rigel authenticates with ${agent.label}.`}>
        <div className="flex flex-col" style={{ gap: 10 }}>
          {agent.authMethods.map((m) => {
            const selected = method === m;
            const copy = METHOD_COPY[m];
            return (
              <div key={m}>
                <button
                  type="button"
                  disabled={comingSoon}
                  onClick={() => setMethod(m)}
                  className="flex w-full items-center rounded-[10px] border text-left transition-colors disabled:cursor-not-allowed"
                  style={{
                    gap: 13,
                    padding: "14px 16px",
                    borderColor: selected ? ACCENT : "rgba(255,255,255,0.08)",
                    background: selected ? "rgba(59,155,232,0.09)" : "transparent",
                    opacity: comingSoon ? 0.6 : 1,
                  }}
                >
                  <Radio selected={selected} />
                  <span className="flex flex-col" style={{ gap: 3 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: "#FFFFFF" }}>{copy.title}</span>
                    <span style={{ fontSize: 13, color: MUTED }}>{copy.sub(agent.vendor)}</span>
                  </span>
                </button>

                {needsSecret && selected && (
                  <input
                    type="password"
                    value={secret}
                    disabled={comingSoon}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={agent.id === "claude" ? "sk-ant-…" : "API key"}
                    className="mt-2 w-full rounded-[10px] border border-white/[0.08] bg-black/20 font-mono outline-none focus:border-[#3B9BE8]"
                    style={{ padding: "12px 14px", fontSize: 13, color: "#FFFFFF" }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </StepCard>

      {comingSoon && (
        <p style={{ fontSize: 13, color: MUTED }}>
          This agent isn't connectable yet. We're building its runner. For now, use Claude.
        </p>
      )}

      {save.isError && <p style={{ fontSize: 13, color: "var(--destructive)" }}>{save.error.message}</p>}

      {/* Footer */}
      <div className="flex items-center justify-end" style={{ gap: 10 }}>
        <button
          type="button"
          onClick={onBack}
          className="rounded-[10px] transition-colors hover:bg-white/[0.04]"
          style={{ padding: "13px 20px", fontSize: 15, fontWeight: 600, color: MUTED }}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saveDisabled}
          onClick={onSave}
          className="rounded-[10px] transition-opacity disabled:opacity-40"
          style={{ padding: "13px 28px", fontSize: 15, fontWeight: 700, color: "#06151C", background: "#5FC9EC" }}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/** Green "Connected" pill, muted "Coming soon" pill, or nothing. */
function StatusPill({ connection, comingSoon }: { connection: AgentView["connection"]; comingSoon: boolean }) {
  if (connection === "connected") {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full" style={{ gap: 7, padding: "6px 13px", background: "rgba(52,208,127,0.12)" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#34D07F" }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "#34D07F" }}>Connected</span>
      </span>
    );
  }
  if (comingSoon) {
    return (
      <span
        className="inline-flex shrink-0 items-center rounded-full"
        style={{ padding: "6px 13px", fontSize: 13, fontWeight: 600, color: MUTED, background: "rgba(255,255,255,0.06)" }}
      >
        Coming soon
      </span>
    );
  }
  return null;
}

/** A numbered step card: badge + heading, description, then its children. */
function StepCard({ n, heading, desc, children }: { n: number; heading: string; desc: string; children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-[14px] border border-white/[0.08]" style={{ gap: 16, padding: 24, background: "#161618" }}>
      <div className="flex items-center" style={{ gap: 12 }}>
        <span
          className="inline-flex items-center justify-center rounded-full"
          style={{ width: 26, height: 26, fontSize: 13, fontWeight: 700, color: "#FFFFFF", background: "rgba(255,255,255,0.08)" }}
        >
          {n}
        </span>
        <span style={{ fontSize: 16, fontWeight: 700, color: "#FFFFFF" }}>{heading}</span>
      </div>
      <p style={{ fontSize: 14, lineHeight: 1.5, color: MUTED }}>{desc}</p>
      {children}
    </div>
  );
}

/** Radio dot: blue ring + filled center when selected, gray ring otherwise. */
function Radio({ selected }: { selected: boolean }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full"
      style={{ width: 20, height: 20, border: `2px solid ${selected ? ACCENT : "#54545C"}` }}
    >
      {selected && <span style={{ width: 9, height: 9, borderRadius: "50%", background: ACCENT }} />}
    </span>
  );
}
