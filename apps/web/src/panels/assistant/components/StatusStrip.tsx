// StatusStrip — compact single-line summary strip for the assistant dashboard.
// One slim horizontal row (status pill, inline stat pairs, token) that wraps
// gracefully on narrow widths. Each value shows a skeleton until its specific
// data source is ready.

import { useAssistantCtx } from "../AssistantContext";
import { Card, Bar } from "./primitives";
import { tokenLabel, tokenColorClass, auditCount } from "../display";

// Subtle vertical divider between groups.
function Divider() {
  return <span aria-hidden className="h-4 w-px shrink-0 bg-border" />;
}

// One inline "LABEL value" pair on a single line.
function InlineStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-baseline gap-1 whitespace-nowrap">
      <span className="font-mono text-[9px] font-medium uppercase text-muted-foreground">
        {label}
      </span>
      {children}
    </span>
  );
}

export function StatusStrip() {
  const { phase, d } = useAssistantCtx();
  const { ready } = d;
  const audit = d.clusterState?.audit ?? [];
  const queue = d.clusterState?.queue ?? [];

  // Skeleton value for any stat whose source hasn't arrived yet.
  const skelVal = <Bar className="h-3.5 w-8" />;

  // Loading: render the strip shape with skeleton values throughout.
  if (phase === "loading") {
    return (
      <Card className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-muted" />
            <Bar className="h-3.5 w-12" />
          </span>
          <Divider />
          {["Awaiting", "Live", "Fixed", "Failed"].map((label) => (
            <InlineStat key={label} label={label}>
              {skelVal}
            </InlineStat>
          ))}
          <Divider />
          <InlineStat label="Token">{skelVal}</InlineStat>
        </div>
      </Card>
    );
  }

  // Settled with no agent present — not installed.
  if (phase === "install") {
    const dash = <span className="text-sm font-semibold text-muted-foreground">—</span>;
    return (
      <Card className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground" />
            <span className="text-sm font-semibold text-muted-foreground">Not installed</span>
          </span>
          <Divider />
          {["Awaiting", "Live", "Fixed", "Failed"].map((label) => (
            <InlineStat key={label} label={label}>
              {dash}
            </InlineStat>
          ))}
          <Divider />
          <InlineStat label="Token">{dash}</InlineStat>
        </div>
      </Card>
    );
  }

  // Installed — show real values, but skeleton per-stat until its source ready.
  return (
    <Card className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        {/* Status pill — ready.deployments (already true here) */}
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              d.enabled ? "bg-green-500" : "bg-muted-foreground"
            }`}
          />
          <span
            className={`text-sm font-semibold ${
              d.enabled
                ? "text-green-600 dark:text-green-400"
                : "text-muted-foreground"
            }`}
          >
            {d.enabled ? "Active" : "Paused"}
          </span>
        </span>

        <Divider />

        {/* Awaiting — ready.state */}
        <InlineStat label="Awaiting">
          {ready.state ? (
            <span
              className={`text-sm font-semibold ${
                queue.length === 0
                  ? "text-muted-foreground"
                  : "text-amber-600 dark:text-amber-400"
              }`}
            >
              {queue.length}
            </span>
          ) : (
            skelVal
          )}
        </InlineStat>

        {/* Live issues — ready.pods (label shortened to "Live") */}
        <InlineStat label="Live">
          {ready.pods ? (
            <span
              className={`text-sm font-semibold ${
                d.liveIssues.length === 0
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              {d.liveIssues.length}
            </span>
          ) : (
            skelVal
          )}
        </InlineStat>

        {/* Fixed — ready.state */}
        <InlineStat label="Fixed">
          {ready.state ? (
            <span className="text-sm font-semibold text-green-600 dark:text-green-400">
              {auditCount(audit, "success")}
            </span>
          ) : (
            skelVal
          )}
        </InlineStat>

        {/* Failed — ready.state */}
        <InlineStat label="Failed">
          {ready.state ? (
            <span
              className={`text-sm font-semibold ${
                auditCount(audit, "failure") === 0
                  ? "text-muted-foreground"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              {auditCount(audit, "failure")}
            </span>
          ) : (
            skelVal
          )}
        </InlineStat>

        <Divider />

        {/* Token — ready.secrets */}
        <InlineStat label="Token">
          {ready.secrets && d.tokenExpiry ? (
            <span className={`text-sm font-semibold ${tokenColorClass(d.tokenExpiry.level)}`}>
              {tokenLabel(d.tokenExpiry)}
            </span>
          ) : (
            skelVal
          )}
        </InlineStat>
      </div>
    </Card>
  );
}
