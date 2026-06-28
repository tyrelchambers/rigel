// CredentialsManager — one row per provider with a readiness chip, a help modal
// explaining how to authenticate (subscription or API key), and a "Source" control
// that opens the CredentialSourceDialog. The dialog hosts both the paste-a-key
// editor (managed mode) and the bring-your-own existing-Secret picker. The row's
// resting state shows ONLY the readiness chip — never the raw backing Secret name
// (that lives inside the dialog). Vendor names come from useAgents(); readiness comes
// from the server's credentialStatus (d.credentialSources) — values never leave the
// cluster.
import { useState } from "react";
import { Info, ExternalLink, AlertTriangle, Wrench } from "lucide-react";
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
import { AgentGlyph } from "@/panels/settings/agents/agentGlyphs";
import {
  useAgents,
  type AgentId,
  type AssistantCredentials,
  type CredentialSourceStatus,
} from "@/lib/api";
import { Card } from "../components/primitives";
import { CredentialSourceDialog } from "./CredentialSourceDialog";
import {
  PROVIDER_IDS,
  PROVIDER_AUTH,
  authMethodSummary,
  credentialReady,
  credentialKeysFor,
  type AuthMethodHelp,
} from "./providerMeta";

export function CredentialsManager({
  credentials,
  credentialSources = {},
  credentialConflicts = [],
  credentialNeedsReconcile = false,
  namespace,
  onSave,
  onSaveSource,
  onUseManaged,
  onReconcile,
  disabled = false,
}: {
  credentials: AssistantCredentials;
  /** Per-credential `{ ready, secretName }` from credentialStatus — drives the
   *  chip and the dialog's "currently backed by" readout. Names only. */
  credentialSources?: Partial<Record<keyof AssistantCredentials, CredentialSourceStatus>>;
  /** Credential ids claimed by more than one Secret — rows for these show an
   *  amber conflict marker. Ids only. */
  credentialConflicts?: (keyof AssistantCredentials)[];
  /** When true, a legacy install needs its credential labels stamped — shows the
   *  Repair button (which does NOT roll the agent). */
  credentialNeedsReconcile?: boolean;
  /** Agent namespace — for listing candidate Secrets in the source dialog. */
  namespace: string;
  /** Managed (paste) save: stores `value` under `key` (the chosen method's key). */
  onSave: (provider: AgentId, key: keyof AssistantCredentials, value: string) => void;
  /** BYO save: point `credentialId` at an existing Secret's data key. Omitted in
   *  the install flow, where the dialog offers managed (paste) mode only. */
  onSaveSource?: (sel: {
    credentialId: keyof AssistantCredentials;
    secretName: string;
    dataKey: string;
  }) => void;
  /** Revert a credential to the Rigel-managed default. Omitted with onSaveSource. */
  onUseManaged?: (credentialId: keyof AssistantCredentials) => void;
  /** Stamp the new label/annotations onto a legacy install's managed Secrets.
   *  Metadata-only (no rollout), so it skips the restart-confirm dialog. */
  onReconcile?: () => void;
  disabled?: boolean;
}) {
  const { data: agents } = useAgents();
  const conflictSet = new Set<keyof AssistantCredentials>(credentialConflicts);

  return (
    <Card className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Credentials</p>
          <p className="text-xs text-muted-foreground">
            Stored as a Kubernetes Secret in the cluster. Only providers a role uses need a key.
          </p>
        </div>
        {credentialNeedsReconcile && onReconcile && (
          <Button
            size="sm"
            variant="muted"
            disabled={disabled}
            onClick={onReconcile}
            title="Stamp the credential labels onto this install's managed Secrets. This only updates Secret metadata and does not restart the agent."
            className="ml-auto shrink-0 text-muted-foreground"
          >
            <Wrench className="mr-1 size-3.5" />
            Repair credential labels
          </Button>
        )}
      </div>
      {PROVIDER_IDS.map((id) => (
        <CredentialRow
          key={id}
          id={id}
          label={agents?.agents.find((a) => a.id === id)?.label ?? id}
          ready={credentialReady(id, credentials)}
          conflict={credentialKeysFor(id).some((k) => conflictSet.has(k))}
          credentialSources={credentialSources}
          namespace={namespace}
          onSave={(key, v) => onSave(id, key, v)}
          onSaveSource={onSaveSource}
          onUseManaged={onUseManaged}
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
  conflict,
  credentialSources,
  namespace,
  onSave,
  onSaveSource,
  onUseManaged,
  disabled,
}: {
  id: AgentId;
  label: string;
  ready: boolean;
  /** A credential this provider uses is claimed by more than one Secret. */
  conflict: boolean;
  credentialSources: Partial<Record<keyof AssistantCredentials, CredentialSourceStatus>>;
  namespace: string;
  onSave: (key: keyof AssistantCredentials, value: string) => void;
  onSaveSource?: (sel: {
    credentialId: keyof AssistantCredentials;
    secretName: string;
    dataKey: string;
  }) => void;
  onUseManaged?: (credentialId: keyof AssistantCredentials) => void;
  disabled: boolean;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);

  // The backing Secret of this provider's primary credential, shown ONLY inside
  // the dialog (never the row's resting state).
  const primaryKey = PROVIDER_AUTH[id][0]!.key;
  const currentSecretName = credentialSources[primaryKey]?.secretName;

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
        {conflict && (
          <span
            role="img"
            data-conflict={id}
            aria-label={`${label} credential conflict`}
            title="More than one Secret claims this credential; the alphabetically-first is used. Repair to fix."
            className="text-amber-500 dark:text-amber-400"
          >
            <AlertTriangle className="size-4" />
          </span>
        )}
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
            ready
              ? "bg-green-500/15 text-green-600 dark:text-green-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {ready ? "Key ready" : "Not set"}
        </span>
        <Button size="sm" variant="muted" disabled={disabled} onClick={() => setSourceOpen(true)}>
          Source
        </Button>
      </div>

      <CredentialSourceDialog
        id={id}
        label={label}
        namespace={namespace}
        open={sourceOpen}
        onOpenChange={setSourceOpen}
        currentSecretName={currentSecretName}
        onSaveKey={(key, value) => {
          setSourceOpen(false);
          onSave(key, value);
        }}
        onSaveSource={
          onSaveSource
            ? (sel) => {
                setSourceOpen(false);
                onSaveSource(sel);
              }
            : undefined
        }
        onUseManaged={
          onUseManaged
            ? (credentialId) => {
                setSourceOpen(false);
                onUseManaged(credentialId);
              }
            : undefined
        }
      />

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
