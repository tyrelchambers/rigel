// CredentialSourceDialog — choose where the assistant reads a provider's credential
// (Pencil frame GGza6). Two modes via a SegmentedTabs toggle:
//   - "Managed by Rigel": the paste-a-key editor (method toggle + input/textarea),
//      same path as before — the value is written to our managed Secret.
//   - "Use an existing Secret": a Secret picker (names only) + a key picker (that
//      Secret's data key names), pointing the credential at an operator-owned Secret.
// Names only — a secret VALUE is never requested or rendered. A method toggle (shared
// across both modes) selects which credential id/env var is being configured.
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { AgentGlyph } from "@/panels/settings/agents/agentGlyphs";
import { useCredentialSecrets, type AgentId, type AssistantCredentials } from "@/lib/api";
import { inputClass } from "../components/primitives";
import { PROVIDER_AUTH, ENV_FOR, type AuthMethodHelp } from "./providerMeta";

type Mode = "managed" | "existing";

export function CredentialSourceDialog({
  id,
  label,
  namespace,
  open,
  onOpenChange,
  currentSecretName,
  onSaveKey,
  onSaveSource,
  onUseManaged,
}: {
  id: AgentId;
  label: string;
  /** Agent namespace — where the candidate Secrets are listed from. */
  namespace: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The backing Secret currently resolved for the selected credential (shown
   *  only here, for transparency — never on the row's resting state). */
  currentSecretName?: string;
  /** Managed (paste) save → stage the value behind the restart confirm. */
  onSaveKey: (key: keyof AssistantCredentials, value: string) => void;
  /** Existing-Secret save → setCredentialSource (behind the restart confirm).
   *  When omitted (e.g. the install flow, where the agent doesn't exist yet),
   *  the dialog offers managed mode only — BYO is a post-install action. */
  onSaveSource?: (sel: {
    credentialId: keyof AssistantCredentials;
    secretName: string;
    dataKey: string;
  }) => void;
  /** Revert to the managed default → clearCredentialSource. Omitted with BYO. */
  onUseManaged?: (credentialId: keyof AssistantCredentials) => void;
}) {
  const methods = PROVIDER_AUTH[id];
  // BYO (existing-Secret mode) is only offered when the caller can persist it.
  const byoEnabled = !!onSaveSource;
  const [mode, setMode] = useState<Mode>("managed");
  // The selected auth method picks which credential id/env var this configures.
  const [methodKind, setMethodKind] = useState(methods[0]!.kind);
  const method = methods.find((m) => m.kind === methodKind) ?? methods[0]!;

  // Managed (paste) editor state.
  const [value, setValue] = useState("");

  // Existing-Secret picker state.
  const { data: secrets } = useCredentialSecrets(open ? namespace : undefined);
  const [secretName, setSecretName] = useState("");
  const [dataKey, setDataKey] = useState("");
  const chosenSecret = (secrets ?? []).find((s) => s.name === secretName);

  function pickSecret(name: string) {
    setSecretName(name);
    setDataKey(""); // the key list changes with the Secret — reset the choice.
  }

  function save() {
    if (mode === "managed") {
      onSaveKey(method.key, value.trim());
    } else {
      onSaveSource?.({ credentialId: method.key, secretName, dataKey });
    }
  }

  const canSave =
    mode === "managed"
      ? value.trim() !== ""
      : secretName !== "" && dataKey !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AgentGlyph id={id} size={20} />
            {label} credential source
          </DialogTitle>
          <DialogDescription>
            Choose where the assistant reads this provider's credential. Saving updates the agent
            Deployment and restarts it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {byoEnabled && (
            <SegmentedTabs
              tabs={[
                { id: "managed", label: "Managed by Rigel" },
                { id: "existing", label: "Use an existing Secret" },
              ]}
              active={mode}
              onChange={(m) => setMode(m as Mode)}
            />
          )}

          {/* The method toggle is shared: it selects which credential (env var)
              this dialog configures, for providers that accept more than one. */}
          {methods.length > 1 && (
            <SegmentedTabs
              tabs={methods.map((m) => ({
                id: m.kind,
                label: m.kind === "subscription" ? "Subscription" : "API key",
              }))}
              active={methodKind}
              onChange={(k) => setMethodKind(k as AuthMethodHelp["kind"])}
            />
          )}

          {mode === "managed" ? (
            <div className="space-y-2">
              {method.multiline ? (
                <textarea
                  autoComplete="off"
                  aria-label="Credential value"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={method.placeholder}
                  rows={5}
                  className="w-full resize-y rounded-md border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                />
              ) : (
                <input
                  type="password"
                  autoComplete="off"
                  aria-label="Credential value"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={method.placeholder}
                  className={`w-full ${inputClass}`}
                />
              )}
              <p className="text-xs text-muted-foreground">
                Stored as a Kubernetes Secret managed by Rigel. The value is never shown again after
                saving.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              <PickerField label="Secret">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="flex flex-1 items-center justify-between rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                    aria-label="Secret"
                  >
                    <span className="truncate">{secretName || "Choose a Secret"}</span>
                    <ChevronDown className="size-4 shrink-0 text-primary" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {(secrets ?? []).map((s) => (
                      <DropdownMenuItem key={s.name} onClick={() => pickSecret(s.name)}>
                        {s.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </PickerField>

              <PickerField label="Key">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={!chosenSecret}
                    className="flex flex-1 items-center justify-between rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                    aria-label="Key"
                  >
                    <span className="truncate">{dataKey || "Choose a key"}</span>
                    <ChevronDown className="size-4 shrink-0 text-primary" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {(chosenSecret?.keys ?? []).map((k) => (
                      <DropdownMenuItem key={k} onClick={() => setDataKey(k)}>
                        {k}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </PickerField>

              {secretName && dataKey && (
                <p className="text-xs text-muted-foreground">
                  The assistant will read {ENV_FOR[method.key]} from {secretName} · {dataKey}. Values
                  never leave the cluster.
                </p>
              )}
            </div>
          )}

          {/* Transparency: the currently-resolved backing Secret (dialog-only). */}
          {byoEnabled && currentSecretName && (
            <p className="text-[11px] text-muted-foreground">
              Currently backed by{" "}
              <span className="font-mono text-foreground">{currentSecretName}</span>.{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => onUseManaged?.(method.key)}
              >
                Use Rigel-managed
              </button>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={save}>
            Save &amp; restart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickerField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
