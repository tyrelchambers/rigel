// ActivityTab — paginated audit log.

import { Button } from "@/components/ui/button";
import { auditEntryId } from "@helmsman/k8s";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Section } from "../components/primitives";
import { AuditRow } from "../AuditRow";

export function ActivityTab() {
  const { d, openAllActivity } = useAssistantCtx();
  const audit = d.clusterState?.audit ?? [];

  return (
    <div className="space-y-3.5">
      <Section
        title={`Activity (${audit.length})`}
        right={
          audit.length > 10 ? (
            <Button variant="ghost" size="sm" onClick={openAllActivity}>
              See all
            </Button>
          ) : undefined
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
