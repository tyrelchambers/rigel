// ActivityTab — paginated audit log.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { auditEntryId } from "@helmsman/k8s";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Section } from "../components/primitives";
import { AuditRow } from "../AuditRow";

export function ActivityTab() {
  const { d, openAllActivity, run, ns, working } = useAssistantCtx();
  const audit = d.clusterState?.audit ?? [];

  // Two-step inline confirm: first click arms, second click within a few seconds
  // clears. Arms revert on timeout or once the list is empty.
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (audit.length === 0 && confirming) setConfirming(false);
  }, [audit.length, confirming]);

  function disarm() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setConfirming(false);
  }

  function onClear() {
    if (!confirming) {
      setConfirming(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirming(false), 4000);
      return;
    }
    disarm();
    run({ action: "clearActivity", namespace: ns });
  }

  return (
    <div className="space-y-3.5">
      <Section
        title={`Activity (${audit.length})`}
        right={
          <div className="flex items-center gap-1.5">
            {audit.length > 10 && (
              <Button variant="ghost" size="sm" onClick={openAllActivity}>
                See all
              </Button>
            )}
            <Button
              variant={confirming ? "destructive" : "ghost"}
              size="sm"
              disabled={working || audit.length === 0}
              onClick={onClear}
            >
              {confirming ? "Confirm clear" : "Clear all"}
            </Button>
          </div>
        }
      >
        <Card>
          {audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">No actions yet.</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-auto">
              {audit.slice(0, 10).map((e) => (
                <AuditRow key={auditEntryId(e)} e={e} />
              ))}
            </div>
          )}
        </Card>
      </Section>
    </div>
  );
}
