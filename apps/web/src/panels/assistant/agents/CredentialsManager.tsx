// CredentialsManager — one row per provider with a status chip, a help modal
// explaining how to authenticate (subscription or API key), and an inline editor.
// Providers that accept more than one credential type (Claude, OpenCode) get a
// method toggle that routes the pasted value to the right Secret key. Vendor
// names come from useAgents(); auth methods + guidance come from PROVIDER_AUTH.
import { useState } from "react";
import { Info, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { AgentGlyph } from "@/panels/settings/agents/agentGlyphs";
import { useAgents, type AgentId, type AssistantCredentials } from "@/lib/api";
import { Card, inputClass } from "../components/primitives";
import {
  PROVIDER_IDS,
  PROVIDER_AUTH,
  authMethodSummary,
  credentialReady,
  type AuthMethodHelp,
} from "./providerMeta";

export function CredentialsManager({
  credentials,
  onSave,
  disabled = false,
}: {
  credentials: AssistantCredentials;
  /** Stores `value` under `key` (the Secret key for the chosen auth method). */
  onSave: (provider: AgentId, key: keyof AssistantCredentials, value: string) => void;
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
          onSave={(key, v) => onSave(id, key, v)}
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
  onSave: (key: keyof AssistantCredentials, value: string) => void;
  disabled: boolean;
}) {
  const methods = PROVIDER_AUTH[id];
  const [editing, setEditing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [value, setValue] = useState("");
  // Selected auth method (recommended first). Drives the target key + placeholder.
  const [methodKind, setMethodKind] = useState(methods[0]!.kind);
  const method = methods.find((m) => m.kind === methodKind) ?? methods[0]!;

  function save() {
    onSave(method.key, value.trim());
    setValue("");
    setEditing(false);
  }

  return (
    <div data-provider={id} className="rounded-md border p-2">
      <div className="flex items-center gap-2">
        <AgentGlyph id={id} size={18} />
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{authMethodSummary(id)}</p>
        </div>
        <button
          type="button"
          aria-label={`How to connect ${label}`}
          title={`How to connect ${label}`}
          onClick={() => setHelpOpen(true)}
          className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
        >
          <Info className="size-4" />
        </button>
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
            ready
              ? "bg-green-500/15 text-green-600 dark:text-green-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {ready ? "Key ready" : "Not set"}
        </span>
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setEditing((e) => !e)}>
          {ready ? "Update" : "Add key"}
        </Button>
      </div>

      {editing && (
        <div className="mt-2 space-y-2">
          {methods.length > 1 && (
            <SegmentedTabs
              tabs={methods.map((m) => ({ id: m.kind, label: m.kind === "subscription" ? "Subscription" : "API key" }))}
              active={methodKind}
              onChange={(k) => setMethodKind(k as AuthMethodHelp["kind"])}
            />
          )}
          {method.multiline ? (
            // Auth-file blobs (e.g. ~/.codex/auth.json) are multi-line; a single-line
            // password input would mangle newlines, so use a textarea.
            <div className="space-y-2">
              <textarea
                autoComplete="off"
                aria-label="Credential value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={method.placeholder}
                rows={5}
                className="w-full resize-y rounded-md border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex justify-end">
                <Button size="sm" disabled={disabled || value.trim() === ""} onClick={save}>
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="off"
                aria-label="Credential value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={method.placeholder}
                className={`w-full ${inputClass}`}
              />
              <Button size="sm" disabled={disabled || value.trim() === ""} onClick={save}>
                Save
              </Button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Info className="size-3" />
            Not sure where to get this? Open the help.
          </button>
        </div>
      )}

      <CredentialHelpDialog id={id} label={label} open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/** Per-provider help modal: how to authenticate (subscription and/or API key). */
function CredentialHelpDialog({
  id,
  label,
  open,
  onOpenChange,
}: {
  id: AgentId;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AgentGlyph id={id} size={20} />
            Connect {label}
          </DialogTitle>
          <DialogDescription>
            Choose how the assistant signs in as {label}. Your credential is stored as a Kubernetes
            Secret in the cluster and is never shown again after saving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {PROVIDER_AUTH[id].map((m) => (
            <MethodCard key={m.kind} method={m} />
          ))}
        </div>

        <DialogFooter>
          <DialogClose render={<Button>Got it</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MethodCard({ method }: { method: AuthMethodHelp }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold">{method.title}</p>
        {method.recommended && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
            Recommended
          </span>
        )}
      </div>
      <ol className="space-y-1.5">
        {method.steps.map((step, i) => (
          <li key={i} className="text-sm text-muted-foreground">
            {i + 1}. {step}
            {/* The command belongs to the step that introduces it (the first). */}
            {i === 0 && method.command && (
              <code className="mt-1.5 block rounded border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground">
                {method.command}
              </code>
            )}
          </li>
        ))}
      </ol>
      {method.link && (
        <a
          href={method.link.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {method.link.label}
          <ExternalLink className="size-3.5" />
        </a>
      )}
      {method.note && <p className="text-xs text-muted-foreground">{method.note}</p>}
    </div>
  );
}
