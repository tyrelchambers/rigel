// AgentsTab — manage the installed Assistant's providers, models, credentials, and
// operational limits. Pre-fills from the LIVE assistant-config (d.roles/d.limits)
// and patches LIVE: setModels (roles), setLimits (limits), setCredentials (keys,
// confirmed because it rollout-restarts the agent). Never re-installs.
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
} from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Section } from "../components/primitives";
import { RolePicker } from "../agents/RolePicker";
import { CredentialsManager } from "../agents/CredentialsManager";
import { LimitsForm } from "../agents/LimitsForm";
import { DEFAULT_LIMITS } from "../agents/providerMeta";

/** A staged credential change awaiting the restart confirm. */
type PendingCredChange =
  | { kind: "paste"; key: keyof AssistantCredentials; value: string }
  | { kind: "source"; credentialId: keyof AssistantCredentials; secretName: string; dataKey: string }
  | { kind: "clear"; credentialId: keyof AssistantCredentials };

export function AgentsTab() {
  const { d, ns, working, run } = useAssistantCtx();
  const queryClient = useQueryClient();

  const [worker, setWorker] = useState<AssistantRoleSelection>(d.roles.worker);
  const [supervisor, setSupervisor] = useState<AssistantRoleSelection>(d.roles.supervisor);
  // Seed with sensible defaults so unset limits show real values, not blanks.
  const [limits, setLimits] = useState<AssistantLimits>({ ...DEFAULT_LIMITS, ...d.limits });
  // The pending credential change staged behind the confirm dialog (every variant
  // rolls the agent). One dialog confirms all three: a pasted key (managed), a
  // bring-your-own existing Secret, or a revert to the managed default.
  const [pending, setPending] = useState<PendingCredChange | null>(null);

  // Re-seed from live config when it changes (parity with RulesTab's effect).
  useEffect(() => {
    setWorker(d.roles.worker);
    setSupervisor(d.roles.supervisor);
  }, [d.roles.worker, d.roles.supervisor]);
  useEffect(() => setLimits({ ...DEFAULT_LIMITS, ...d.limits }), [d.limits]);

  function saveRolesAndLimits() {
    run({ action: "setModels", namespace: ns, worker, supervisor });
    run({ action: "setLimits", namespace: ns, limits });
  }

  function confirmCredential() {
    if (!pending) return;
    // Build the right action for the staged change; all three roll the agent and
    // change the resolved credential, so all three refresh credentialStatus.
    let req: AssistantRequest;
    if (pending.kind === "paste") {
      req = { action: "setCredentials", namespace: ns, credentials: { [pending.key]: pending.value } };
    } else if (pending.kind === "source") {
      req = {
        action: "setCredentialSource",
        namespace: ns,
        credentialId: pending.credentialId,
        secretName: pending.secretName,
        dataKey: pending.dataKey,
      };
    } else {
      req = { action: "clearCredentialSource", namespace: ns, credentialId: pending.credentialId };
    }
    run(req, () => {
      void queryClient.invalidateQueries({ queryKey: ["assistant-credentialStatus", ns] });
    });
    setPending(null);
  }

  // Repair: stamp the credential labels onto a legacy install's managed Secrets.
  // This only changes Secret METADATA (no Deployment apply, no rollout), so it
  // runs directly — NOT through the restart-confirm dialog the credential edits use.
  function reconcileLabels() {
    run({ action: "reconcileCredentialAnnotations", namespace: ns }, () => {
      void queryClient.invalidateQueries({ queryKey: ["assistant-credentialStatus", ns] });
    });
  }

  return (
    <div className="space-y-3.5">
      <div>
        <p className="text-sm font-semibold">Agents &amp; providers</p>
        <p className="text-xs text-muted-foreground">
          Pick which AI runs each role of the Assistant. Model changes apply on the next poll; adding
          a credential restarts the agent.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <RolePicker
          label="Worker"
          description="Investigates incidents, proposes fixes"
          value={worker}
          onChange={setWorker}
          disabled={working}
        />
        <RolePicker
          label="Supervisor"
          description="Adversarially reviews risky actions"
          value={supervisor}
          onChange={setSupervisor}
          disabled={working}
        />
      </div>

      <CredentialsManager
        credentials={d.creds}
        credentialSources={d.credentialSources}
        credentialConflicts={d.credentialConflicts}
        credentialNeedsReconcile={d.credentialNeedsReconcile}
        namespace={ns}
        onSave={(_provider, key, value) => setPending({ kind: "paste", key, value })}
        onSaveSource={({ credentialId, secretName, dataKey }) =>
          setPending({ kind: "source", credentialId, secretName, dataKey })
        }
        onUseManaged={(credentialId) => setPending({ kind: "clear", credentialId })}
        onReconcile={reconcileLabels}
        disabled={working}
      />

      <Section title="Operational limits">
        <Card>
          <LimitsForm value={limits} onChange={setLimits} disabled={working} />
        </Card>
      </Section>

      <div className="flex items-center justify-between border-t pt-3">
        <p className="text-xs text-muted-foreground">
          Model and limit changes are live (next poll). Credential changes restart the agent.
        </p>
        <Button disabled={working} onClick={saveRolesAndLimits}>
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
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button onClick={confirmCredential}>Save &amp; restart</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
