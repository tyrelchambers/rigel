// StatusStrip — compact summary strip for the assistant dashboard. One bordered
// row: the live state on the left with inline stat pairs (awaiting / live /
// fixed / failed), the token budget pushed to the right. Wraps gracefully on
// narrow widths; each value shows a skeleton until its data source is ready.
// Built to Pencil frame "Assistant — Overview (improved)" (status strip).

import { Timer } from "lucide-react";
import { useAssistantCtx } from "../AssistantContext";
import { Bar } from "./primitives";
import { tokenLabel, tokenColorClass, auditCount } from "../display";

// Card shell shared across every phase so the strip keeps a stable shape.
function Strip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-[18px] py-3.5">
      {children}
    </div>
  );
}

// Subtle vertical divider between groups.
function Divider() {
  return <span aria-hidden className="h-[22px] w-px shrink-0 bg-[var(--border-strong)]" />;
}

// One inline "LABEL value" pair on a single line.
function InlineStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-[var(--fg-tertiary)]">
        {label}
      </span>
      {children}
    </span>
  );
}

// A settled stat value (mono, colour-coded).
function StatValue({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`font-mono text-[15px] font-semibold ${className}`}>{children}</span>;
}

/** Timer-icon token group, right-aligned. */
function TokenGroup({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <Timer className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />
      <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-[var(--fg-tertiary)]">
        Token
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
  const stats = ["Awaiting", "Live", "Fixed", "Failed"] as const;

  // Loading: render the strip shape with skeleton values throughout.
  if (phase === "loading") {
    return (
      <Strip>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-muted" />
            <Bar className="h-3.5 w-14" />
          </span>
          <Divider />
          {stats.map((label) => (
            <InlineStat key={label} label={label}>
              {skelVal}
            </InlineStat>
          ))}
        </div>
        <TokenGroup>{skelVal}</TokenGroup>
      </Strip>
    );
  }

  // Settled with no agent present — not installed.
  if (phase === "install") {
    const dash = <StatValue className="text-[var(--fg-tertiary)]">—</StatValue>;
    return (
      <Strip>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-[var(--fg-tertiary)]" />
            <span className="text-[15px] font-semibold text-[var(--fg-tertiary)]">Not installed</span>
          </span>
          <Divider />
          {stats.map((label) => (
            <InlineStat key={label} label={label}>
              {dash}
            </InlineStat>
          ))}
        </div>
        <TokenGroup>{dash}</TokenGroup>
      </Strip>
    );
  }

  // Installed — show real values, but skeleton per-stat until its source ready.
  return (
    <Strip>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {/* Status — ready.deployments (already true here) */}
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span
            className={`size-2 shrink-0 rounded-full ${
              d.enabled ? "bg-[var(--status-running)]" : "bg-[var(--fg-tertiary)]"
            }`}
          />
          <span
            className={`text-[15px] font-semibold ${
              d.enabled ? "text-[var(--status-running)]" : "text-[var(--fg-tertiary)]"
            }`}
          >
            {d.enabled ? "Active" : "Paused"}
          </span>
        </span>

        <Divider />

        {/* Awaiting — ready.state */}
        <InlineStat label="Awaiting">
          {ready.state ? (
            <StatValue
              className={queue.length === 0 ? "text-[var(--fg-primary)]" : "text-[var(--status-pending)]"}
            >
              {queue.length}
            </StatValue>
          ) : (
            skelVal
          )}
        </InlineStat>

        {/* Live issues — ready.pods */}
        <InlineStat label="Live">
          {ready.pods ? (
            <StatValue
              className={
                d.liveIssues.length === 0 ? "text-[var(--status-running)]" : "text-[var(--status-failed)]"
              }
            >
              {d.liveIssues.length}
            </StatValue>
          ) : (
            skelVal
          )}
        </InlineStat>

        {/* Fixed — ready.state */}
        <InlineStat label="Fixed">
          {ready.state ? (
            <StatValue className="text-[var(--status-running)]">{auditCount(audit, "success")}</StatValue>
          ) : (
            skelVal
          )}
        </InlineStat>

        {/* Failed — ready.state */}
        <InlineStat label="Failed">
          {ready.state ? (
            <StatValue
              className={
                auditCount(audit, "failure") === 0 ? "text-[var(--fg-primary)]" : "text-[var(--status-failed)]"
              }
            >
              {auditCount(audit, "failure")}
            </StatValue>
          ) : (
            skelVal
          )}
        </InlineStat>
      </div>

      {/* Token — ready.secrets */}
      <TokenGroup>
        {ready.secrets && d.tokenExpiry ? (
          <span className={`font-mono text-sm font-semibold ${tokenColorClass(d.tokenExpiry.level)}`}>
            {tokenLabel(d.tokenExpiry)}
          </span>
        ) : (
          skelVal
        )}
      </TokenGroup>
    </Strip>
  );
}
