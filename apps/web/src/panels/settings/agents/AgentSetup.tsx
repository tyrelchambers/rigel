import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useSetAgentAuth, type AgentAuthMethod, type AgentView } from "@/lib/api";
import { AgentGlyph } from "./agentGlyphs";

const METHOD_LABEL: Record<AgentAuthMethod, string> = {
  subscription: "Your existing CLI login (subscription)",
  apiKey: "API key",
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
    <div className="flex flex-col gap-5">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 self-start" style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
        <ChevronLeft size={15} /> Back
      </button>

      <div className="flex items-center gap-2.5" style={{ color: "var(--fg-primary)" }}>
        <AgentGlyph id={agent.id} size={24} />
        <div style={{ fontSize: 18, fontWeight: 600 }}>{agent.label}</div>
        {comingSoon && (
          <span className="rounded-full px-2 py-0.5" style={{ fontSize: 11, color: "var(--fg-tertiary)", border: "1px solid var(--border-subtle)" }}>
            Coming soon
          </span>
        )}
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-primary)" }}>Step 1</div>
        <a href={agent.installUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: "var(--accent-primary)" }}>
          {agent.installLabel}
        </a>
      </div>

      <div className="flex flex-col gap-2">
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-primary)" }}>Step 2 — Authenticate with</div>
        {agent.authMethods.map((m) => (
          <label key={m} className="flex items-center gap-2" style={{ fontSize: 13, color: "var(--fg-secondary)", opacity: comingSoon ? 0.6 : 1 }}>
            <input type="radio" name="auth" disabled={comingSoon} checked={method === m} onChange={() => setMethod(m)} />
            {METHOD_LABEL[m]}
          </label>
        ))}

        {needsSecret && (
          <input
            type="password"
            value={secret}
            disabled={comingSoon}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={agent.id === "claude" ? "sk-ant-…" : "API key"}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        )}
      </div>

      {comingSoon && (
        <p style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>
          This agent isn't connectable yet. We're building its runner — for now, use Claude.
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saveDisabled}
          onClick={onSave}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {save.isError && <span style={{ fontSize: 12, color: "var(--destructive)" }}>{save.error.message}</span>}
      </div>
    </div>
  );
}
