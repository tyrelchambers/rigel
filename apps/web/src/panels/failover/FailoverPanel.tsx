import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { FailoverSelect } from "./FailoverSelect";
import { FailoverRunning } from "./FailoverRunning";
import {
  useFailoverConfig,
  useFailoverEdgeConfirm,
  useFailoverJob,
  useFailoverPlan,
  useFailoverRestore,
  useFailoverRun,
  useFailoverScaleHome,
  useFailoverState,
  useFailoverTeardown,
  type FailoverPlanView,
} from "@/lib/api";

export default function FailoverPanel() {
  const dest = useFailoverConfig();
  const live = useFailoverState();
  const planMut = useFailoverPlan();
  const runMut = useFailoverRun();
  const job = useFailoverJob();
  const confirm = useFailoverEdgeConfirm();
  const scale = useFailoverScaleHome();
  const restore = useFailoverRestore();
  const teardown = useFailoverTeardown();
  const [rewrites, setRewrites] = useState<Array<{ rule: string; to: unknown }>>([]);
  const [selection, setSelection] = useState<unknown>(null);
  const plan = planMut.data;
  const active = live.data?.failedOverTo;

  function accept(rule: string, to: unknown) {
    setRewrites((prev) => [...prev.filter((r) => r.rule !== rule), { rule, to }]);
  }

  if (dest.data && !dest.data.configured) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Failover" subtitle="Stand a copy up on DigitalOcean" />
        <div className="flex flex-1 flex-col items-start gap-3 p-5">
          <p className="text-sm text-muted-foreground">
            Configure a DigitalOcean destination first. Nothing is created until you run a failover.
          </p>
          <Link
            to="/settings?tab=failover"
            className="inline-flex h-7 items-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-elevated)] px-3 text-2xs font-bold"
          >
            Open Failover settings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Failover" subtitle="Storm-time copy on DigitalOcean" count={plan?.members.length} loading={planMut.isPending || runMut.isPending} />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-5">
        {live.data?.leftBehind && (
          <section className="flex flex-col gap-2 rounded-md border border-[var(--status-failed)] bg-[var(--surface-elevated)] p-3">
            <h2 className="text-sm font-semibold">A DigitalOcean cluster was left behind</h2>
            <p className="text-xs text-muted-foreground">
              Your data is home, but the destination did not tear down and is still billing by the hour.
            </p>
            <p className="font-mono text-2xs text-[var(--fg-tertiary)]">
              {live.data.leftBehind.clusterId} · {live.data.leftBehind.error}
            </p>
            <div>
              <Button size="sm" variant="destructive" disabled={teardown.isPending} onClick={() => teardown.mutate()}>
                Destroy it now
              </Button>
            </div>
            {teardown.error && <p className="text-xs text-[var(--status-failed)]">{teardown.error.message}</p>}
          </section>
        )}

        {active && (
          <ActiveFailover
            snippet={job.data?.result?.edgeChange.snippet}
            revert={job.data?.result?.edgeChange.revertSnippet}
            confirmed={active.edgeConfirmed}
            onConfirm={() => confirm.mutate()}
            onScale={() => scale.mutate()}
            onRestore={() => restore.mutate()}
            confirmPending={confirm.isPending}
            scalePending={scale.isPending}
            restorePending={restore.isPending}
            error={confirm.error?.message ?? scale.error?.message ?? restore.error?.message}
          />
        )}

        {job.data && <FailoverRunning job={job.data} />}

        <FailoverSelect
          previewPending={planMut.isPending}
          onPreview={(next) => {
            setSelection(next);
            planMut.mutate({ selection: next, acceptedRewrites: rewrites });
          }}
        />

        {plan && <PlanBody plan={plan} onAccept={accept} accepted={rewrites} />}

        {plan && (
          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              disabled={plan.blockers.length > 0 || runMut.isPending || !selection || job.data?.status === "running"}
              onClick={() => selection && runMut.mutate({ selection, acceptedRewrites: rewrites })}
            >
              Run failover
            </Button>
            {plan.blockers.length > 0 && (
              <p className="text-xs text-[var(--status-failed)]">
                {plan.blockers.length} blocker{plan.blockers.length === 1 ? "" : "s"} remaining. Accept rewrites or fix them first.
              </p>
            )}
            {runMut.error && <p className="text-xs text-[var(--status-failed)]">{runMut.error.message}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function PlanBody({
  plan,
  onAccept,
  accepted,
}: {
  plan: FailoverPlanView;
  onAccept: (rule: string, to: unknown) => void;
  accepted: Array<{ rule: string; to: unknown }>;
}) {
  const acceptedRules = new Set(accepted.map((a) => a.rule));
  return (
    <>
      <Section title={`Workloads and routing (${plan.members.length})`}>
        <ul className="font-mono text-2xs text-[var(--fg-secondary)]">
          {plan.members.map((m) => (
            <li key={`${m.kind}/${m.namespace}/${m.name}`}>{m.kind} {m.namespace}/{m.name}</li>
          ))}
        </ul>
      </Section>
      <Section title="Data">
        {plan.plans.length === 0 && <p className="text-xs text-muted-foreground">No data plans yet.</p>}
        {plan.plans.map((p) => (
          <p key={`${p.subject.kind}/${p.subject.name}`} className="text-xs text-[var(--fg-secondary)]">
            {p.kind} {p.subject.namespace}/{p.subject.name}
            {p.bytes != null ? ` (${Math.round(p.bytes / (1024 * 1024))} MiB)` : ""}
            {p.warning ? `. ${p.warning}` : ""}
          </p>
        ))}
      </Section>
      {plan.outbound.length > 0 && (
        <Section title="Held at zero until restore">
          {plan.outbound.map((m) => (
            <p key={m.name} className="text-xs text-[var(--fg-secondary)]">{m.kind} {m.namespace}/{m.name}</p>
          ))}
        </Section>
      )}
      <Section title={`Connections (${plan.endpointRewrites.length})`}>
        {plan.endpointRewrites.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Every database address in the closure already resolves on the target under the same name.
          </p>
        )}
        {plan.endpointRewrites.map((r) => (
          <div
            key={`${r.subject.namespace}/${r.subject.name}/${r.key}`}
            className="flex flex-col gap-1 rounded-md border border-[var(--status-pending)] bg-[var(--surface-elevated)] p-3"
          >
            <p className="font-mono text-2xs text-[var(--fg-secondary)]">
              <span className="font-bold text-[var(--status-pending)]">REWRITE</span> {r.subject.kind}{" "}
              {r.subject.namespace}/{r.subject.name} · {r.key}
            </p>
            <p className="font-mono text-2xs text-[var(--fg-tertiary)]">from {r.from}</p>
            <p className="font-mono text-2xs text-[var(--accent-soft)]">to {r.to}</p>
            <p className="text-xs text-muted-foreground">
              {r.via} does not survive the move. Only the copy applied to DigitalOcean changes.
            </p>
          </div>
        ))}
      </Section>
      <Section title="Findings">
        {plan.findings.length === 0 && <p className="text-xs text-muted-foreground">No portability findings.</p>}
        {plan.findings.map((f) => (
          <div key={`${f.rule}/${f.subject.name}`} className="flex flex-col gap-1 border-b border-[var(--border-subtle)] py-2">
            <p className="text-2xs font-bold uppercase text-[var(--fg-tertiary)]">{f.severity} · {f.rule}</p>
            <p className="text-xs text-[var(--fg-secondary)]">{f.whatsWrong}</p>
            {f.rewrite && !acceptedRules.has(f.rule) && (
              <Button size="sm" variant="outline" onClick={() => onAccept(f.rule, f.rewrite!.to)}>
                {f.rewrite.label}
              </Button>
            )}
            {acceptedRules.has(f.rule) && <p className="text-2xs text-[var(--status-running)]">Accepted</p>}
          </div>
        ))}
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ActiveFailover({
  snippet,
  revert,
  confirmed,
  onConfirm,
  onScale,
  onRestore,
  confirmPending,
  scalePending,
  restorePending,
  error,
}: {
  snippet?: string;
  revert?: string;
  confirmed: boolean;
  onConfirm: () => void;
  onScale: () => void;
  onRestore: () => void;
  confirmPending: boolean;
  scalePending: boolean;
  restorePending: boolean;
  error?: string;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--status-pending)] bg-[var(--surface-elevated)] p-3">
      <h2 className="text-sm font-semibold">Failover is active</h2>
      <p className="text-xs text-muted-foreground">
        Rigel never SSHes into your edge. Paste the cutover there yourself, then confirm.
      </p>
      {snippet && <pre className="overflow-x-auto rounded-md bg-[var(--surface-sunken)] p-2 font-mono text-2xs">{snippet}</pre>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={confirmed || confirmPending} onClick={onConfirm}>
          Edge cutover is live
        </Button>
        <Button size="sm" variant="outline" disabled={!confirmed || scalePending} onClick={onScale}>
          Scale home to zero
        </Button>
        <Button size="sm" variant="outline" disabled={restorePending} onClick={onRestore}>
          Restore home
        </Button>
      </div>
      {revert && <pre className="overflow-x-auto rounded-md bg-[var(--surface-sunken)] p-2 font-mono text-2xs">{revert}</pre>}
      {error && <p className="text-xs text-[var(--status-failed)]">{error}</p>}
    </section>
  );
}
