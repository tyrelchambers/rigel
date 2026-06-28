// AssistantConfigSection — prop-driven config UI for worker/supervisor roles,
// credentials, and operational limits. Extracted from AgentsTab so it can be
// reused on the Settings page without requiring an AssistantContext.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type {
  AssistantCredentials,
  AssistantLimits,
  AssistantRequest,
  AssistantRoleSelection,
  CredentialSourceStatus,
} from "@/lib/api";
import { Card, Section } from "../components/primitives";
import { RolePicker } from "./RolePicker";
import { CredentialsManager } from "./CredentialsManager";
import { LimitsForm } from "./LimitsForm";
import { DEFAULT_LIMITS } from "./providerMeta";

/** A staged credential change awaiting the restart confirm. */
type PendingCredChange =
  | { kind: "paste"; key: keyof AssistantCredentials; value: string }
  | { kind: "source"; credentialId: keyof AssistantCredentials; secretName: string; dataKey: string }
  | { kind: "clear"; credentialId: keyof AssistantCredentials };

export interface AssistantConfigSectionProps {
  roles: { worker: AssistantRoleSelection; supervisor: AssistantRoleSelection };
  limits: AssistantLimits;
  creds: AssistantCredentials;
  credentialSources?: Partial<Record<keyof AssistantCredentials, CredentialSourceStatus>>;
  credentialConflicts?: (keyof AssistantCredentials)[];
  credentialNeedsReconcile?: boolean;
  namespace: string;
  working: boolean;
  run: (req: AssistantRequest, onDone?: () => void) => void;
  disabled?: boolean;
}

export function AssistantConfigSection({
  roles,
  limits: limitsProp,
  creds,
  credentialSources,
  credentialConflicts,
  credentialNeedsReconcile,
  namespace,
  working,
  run,
  disabled,
}: AssistantConfigSectionProps) {
  const queryClient = useQueryClient();

  const [worker, setWorker] = useState<AssistantRoleSelection>(roles.worker);
  const [supervisor, setSupervisor] = useState<AssistantRoleSelection>(roles.supervisor);
  // Seed with sensible defaults so unset limits show real values, not blanks.
  const [limits, setLimits] = useState<AssistantLimits>({ ...DEFAULT_LIMITS, ...limitsProp });
  // The pending credential change staged behind the confirm dialog (every variant
  // rolls the agent). One dialog confirms all three: a pasted key (managed), a
  // bring-your-own existing Secret, or a revert to the managed default.
  const [pending, setPending] = useState<PendingCredChange | null>(null);

  // Re-seed from live config when it changes (parity with RulesTab's effect).
  useEffect(() => {
    setWorker(roles.worker);
    setSupervisor(roles.supervisor);
  }, [roles.worker, roles.supervisor]);
  useEffect(() => setLimits({ ...DEFAULT_LIMITS, ...limitsProp }), [limitsProp]);

  function saveRolesAndLimits() {
    run({ action: "setModels", namespace, worker, supervisor });
    run({ action: "setLimits", namespace, limits });
  }

  function confirmCredential() {
    if (!pending) return;
    // Build the right action for the staged change; all three roll the agent and
    // change the resolved credential, so all three refresh credentialStatus.
    let req: AssistantRequest;
    if (pending.kind === "paste") {
      req = { action: "setCredentials", namespace, credentials: { [pending.key]: pending.value } };
    } else if (pending.kind === "source") {
      req = {
        action: "setCredentialSource",
        namespace,
        credentialId: pending.credentialId,
        secretName: pending.secretName,
        dataKey: pending.dataKey,
      };
    } else {
      req = { action: "clearCredentialSource", namespace, credentialId: pending.credentialId };
    }
    run(req, () => {
      void queryClient.invalidateQueries({ queryKey: ["assistant-credentialStatus", namespace] });
    });
    setPending(null);
  }

  // Repair: stamp the credential labels onto a legacy install's managed Secrets.
  // This only changes Secret METADATA (no Deployment apply, no rollout), so it
  // runs directly — NOT through the restart-confirm dialog the credential edits use.
  function reconcileLabels() {
    run({ action: "reconcileCredentialAnnotations", namespace }, () => {
      void queryClient.invalidateQueries({ queryKey: ["assistant-credentialStatus", namespace] });
    });
  }

  const isDisabled = disabled || working;

  return (
    <div className="space-y-3.5">
      <div className="grid grid-cols-2 gap-3">
        <RolePicker
          label="Worker"
          description="Investigates incidents, proposes fixes"
          value={worker}
          onChange={setWorker}
          disabled={isDisabled}
        />
        <RolePicker
          label="Supervisor"
          description="Adversarially reviews risky actions"
          value={supervisor}
          onChange={setSupervisor}
          disabled={isDisabled}
        />
      </div>

      <CredentialsManager
        credentials={creds}
        credentialSources={credentialSources}
        credentialConflicts={credentialConflicts}
        credentialNeedsReconcile={credentialNeedsReconcile}
        namespace={namespace}
        onSave={(_provider, key, value) => setPending({ kind: "paste", key, value })}
        onSaveSource={({ credentialId, secretName, dataKey }) =>
          setPending({ kind: "source", credentialId, secretName, dataKey })
        }
        onUseManaged={(credentialId) => setPending({ kind: "clear", credentialId })}
        onReconcile={reconcileLabels}
        disabled={isDisabled}
      />

      <Section title="Operational limits">
        <Card>
          <LimitsForm value={limits} onChange={setLimits} disabled={isDisabled} />
        </Card>
      </Section>

      <div className="flex items-center justify-between border-t pt-3">
        <p className="text-xs text-muted-foreground">
          Model and limit changes are live (next poll). Credential changes restart the agent.
        </p>
        <Button disabled={isDisabled} onClick={saveRolesAndLimits}>
          Save changes
        </Button>
      </div>

      {/* Confirm a credential change (it rollout-restarts the agent). One dialog
          covers a pasted key, a bring-your-own Secret, and a revert to managed. */}
      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save credential and restart the agent?</DialogTitle>
            <DialogDescription>
              {pending?.kind === "clear"
                ? "Reverting to the Rigel-managed Secret re-renders the agent Deployment and rolls the agent pod. In-flight work is interrupted."
                : pending?.kind === "source"
                  ? "Pointing this credential at the chosen Secret re-renders the agent Deployment and rolls the agent pod. The secret value never leaves the cluster. In-flight work is interrupted."
                  : "Saving this key updates the cluster Secret and rolls the agent pod so it picks up the new credential. In-flight work is interrupted."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="muted" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button onClick={confirmCredential}>Save &amp; restart</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
