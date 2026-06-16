// StatusStrip — always-rendered 7-tile summary bar.
// Each tile shows a skeleton until its specific data source is ready.

import { useAssistantCtx } from "../AssistantContext";
import { Card, Stat, Bar } from "./primitives";
import { spendLabel, tokenLabel, tokenColorClass, auditCount } from "../display";

export function StatusStrip() {
  const { phase, d } = useAssistantCtx();
  const { ready } = d;
  const audit = d.clusterState?.audit ?? [];
  const queue = d.clusterState?.queue ?? [];
  const status = d.clusterState?.status;

  // Skeleton value for any tile whose source hasn't arrived yet.
  const skelVal = <Bar className="h-4 w-12" />;

  // Loading: every tile value is a skeleton.
  if (phase === "loading") {
    return (
      <Card>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {["Status", "Awaiting", "Live issues", "Fixed", "Failed", "Spend", "Token"].map((label) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="font-mono text-[9px] font-medium uppercase text-muted-foreground">
                {label}
              </span>
              {skelVal}
            </div>
          ))}
        </div>
      </Card>
    );
  }

  // Settled with no agent present — not installed.
  if (phase === "install") {
    return (
      <Card>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Stat label="Status" value="Not installed" color="text-muted-foreground" />
          {["Awaiting", "Live issues", "Fixed", "Failed", "Spend", "Token"].map((label) => (
            <Stat key={label} label={label} value="—" color="text-muted-foreground" />
          ))}
        </div>
      </Card>
    );
  }

  // Installed — show real values, but skeleton per-tile until its source ready.
  return (
    <Card>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {/* Status — ready.deployments (already true here) */}
        <Stat
          label="Status"
          value={d.enabled ? "Active" : "Paused"}
          color={d.enabled ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}
        />

        {/* Awaiting — ready.state */}
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[9px] font-medium uppercase text-muted-foreground">
            Awaiting
          </span>
          {ready.state ? (
            <span className={`text-sm font-semibold ${queue.length === 0 ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}>
              {queue.length}
            </span>
          ) : skelVal}
        </div>

        {/* Live issues — ready.pods */}
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[9px] font-medium uppercase text-muted-foreground">
            Live issues
          </span>
          {ready.pods ? (
            <span className={`text-sm font-semibold ${d.liveIssues.length === 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
              {d.liveIssues.length}
            </span>
          ) : skelVal}
        </div>

        {/* Fixed — ready.state */}
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[9px] font-medium uppercase text-muted-foreground">
            Fixed
          </span>
          {ready.state ? (
            <span className="text-sm font-semibold text-green-600 dark:text-green-400">
              {auditCount(audit, "success")}
            </span>
          ) : skelVal}
        </div>

        {/* Failed — ready.state */}
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[9px] font-medium uppercase text-muted-foreground">
            Failed
          </span>
          {ready.state ? (
            <span className={`text-sm font-semibold ${auditCount(audit, "failure") === 0 ? "text-muted-foreground" : "text-red-600 dark:text-red-400"}`}>
              {auditCount(audit, "failure")}
            </span>
          ) : skelVal}
        </div>

        {/* Spend — ready.state + status present */}
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[9px] font-medium uppercase text-muted-foreground">
            Spend
          </span>
          {ready.state && status ? (
            <span className="text-sm font-semibold text-foreground">
              {spendLabel(status.spentUsd, status.spendCapUsd)}
            </span>
          ) : skelVal}
        </div>

        {/* Token — ready.secrets */}
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[9px] font-medium uppercase text-muted-foreground">
            Token
          </span>
          {ready.secrets && d.tokenExpiry ? (
            <span className={`text-sm font-semibold ${tokenColorClass(d.tokenExpiry.level)}`}>
              {tokenLabel(d.tokenExpiry)}
            </span>
          ) : skelVal}
        </div>
      </div>
    </Card>
  );
}
