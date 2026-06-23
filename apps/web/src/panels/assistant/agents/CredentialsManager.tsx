// CredentialsManager — one row per provider with a status chip + an inline
// Add/Update key editor. Vendor names + auth-method copy come from useAgents().
// onSave(provider, value) hands the raw pasted value to the parent, which maps it
// onto the right Secret key (credentialKeyFor) and patches or stages it.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AgentGlyph } from "@/panels/settings/agents/agentGlyphs";
import { useAgents, type AgentId, type AssistantCredentials } from "@/lib/api";
import { Card, inputClass } from "../components/primitives";
import { PROVIDER_IDS, credentialReady } from "./providerMeta";

/** Auth-method label: Claude can use a subscription token OR an API key; the rest are API-key only. */
function authLabel(id: AgentId): string {
  return id === "claude" ? "Subscription token or API key" : "API key";
}

export function CredentialsManager({
  credentials,
  onSave,
  disabled = false,
}: {
  credentials: AssistantCredentials;
  onSave: (provider: AgentId, value: string) => void;
  disabled?: boolean;
}) {
  const { data: agents } = useAgents();

  return (
    <Card className="space-y-2">
      <div>
        <p className="text-sm font-semibold">Credentials</p>
        <p className="text-xs text-muted-foreground">
          Stored as a Kubernetes Secret in the cluster. Only providers a role uses need a key.
        </p>
      </div>
      {PROVIDER_IDS.map((id) => (
        <CredentialRow
          key={id}
          id={id}
          label={agents?.agents.find((a) => a.id === id)?.label ?? id}
          ready={credentialReady(id, credentials)}
          onSave={(v) => onSave(id, v)}
          disabled={disabled}
        />
      ))}
    </Card>
  );
}

function CredentialRow({
  id,
  label,
  ready,
  onSave,
  disabled,
}: {
  id: AgentId;
  label: string;
  ready: boolean;
  onSave: (value: string) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  return (
    <div data-provider={id} className="rounded-md border p-2">
      <div className="flex items-center gap-2">
        <AgentGlyph id={id} size={18} />
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{authLabel(id)}</p>
        </div>
        <span
          className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
            ready
              ? "bg-green-500/15 text-green-600 dark:text-green-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {ready ? "Key ready" : "Not set"}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => setEditing((e) => !e)}
        >
          {ready ? "Update" : "Add key"}
        </Button>
      </div>
      {editing && (
        <div className="mt-2 flex gap-2">
          <input
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={id === "claude" ? "Token or API key" : "API key"}
            className={`w-full ${inputClass}`}
          />
          <Button
            size="sm"
            disabled={disabled || value.trim() === ""}
            onClick={() => {
              onSave(value.trim());
              setValue("");
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
