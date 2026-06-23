// AgentsTab — manage the installed Assistant's providers, models, credentials, and
// operational limits. Pre-fills from the LIVE assistant-config (d.roles/d.limits)
// and patches LIVE: setModels (roles), setLimits (limits), setCredentials (keys,
// confirmed because it rollout-restarts the agent). Never re-installs.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { AgentId, AssistantCredentials, AssistantLimits, AssistantRoleSelection } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import type { AssistantDerived } from "../useAssistant";

// d.creds is added to AssistantDerived in Task 6c. Until that lands, extend
// locally so this file typechecks independently.
type AssistantDerivedWithCreds = AssistantDerived & { creds?: AssistantCredentials };
import { Card, Section } from "../components/primitives";
import { RolePicker } from "../agents/RolePicker";
import { CredentialsManager } from "../agents/CredentialsManager";
import { LimitsForm } from "../agents/LimitsForm";
import { credentialKeyFor } from "../agents/providerMeta";

export function AgentsTab() {
  const { d, ns, working, run } = useAssistantCtx();

  const [worker, setWorker] = useState<AssistantRoleSelection>(d.roles.worker);
  const [supervisor, setSupervisor] = useState<AssistantRoleSelection>(d.roles.supervisor);
  const [limits, setLimits] = useState<AssistantLimits>(d.limits);
  // The credential being staged behind the confirm dialog (it rolls the agent).
  const [pendingCred, setPendingCred] = useState<{ provider: AgentId; value: string } | null>(null);

  // Re-seed from live config when it changes (parity with RulesTab's effect).
  useEffect(() => {
    setWorker(d.roles.worker);
    setSupervisor(d.roles.supervisor);
  }, [d.roles.worker, d.roles.supervisor]);
  useEffect(() => setLimits(d.limits), [d.limits]);

  function saveRolesAndLimits() {
    run({ action: "setModels", namespace: ns, worker, supervisor });
    run({ action: "setLimits", namespace: ns, limits });
  }

  function confirmCredential() {
    if (!pendingCred) return;
    const key = credentialKeyFor(pendingCred.provider);
    run({ action: "setCredentials", namespace: ns, credentials: { [key]: pendingCred.value } });
    setPendingCred(null);
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
        credentials={(d as AssistantDerivedWithCreds).creds ?? {}}
        onSave={(provider, value) => setPendingCred({ provider, value })}
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

      {/* Confirm a credential change (it rollout-restarts the agent). */}
      <Dialog open={!!pendingCred} onOpenChange={(o) => !o && setPendingCred(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save credential and restart the agent?</DialogTitle>
            <DialogDescription>
              Saving this key updates the cluster Secret and rolls the agent pod so it picks up the
              new credential. In-flight work is interrupted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingCred(null)}>
              Cancel
            </Button>
            <Button onClick={confirmCredential}>Save &amp; restart</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
