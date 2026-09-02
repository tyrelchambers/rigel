import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/panels/components/PanelHeader";
import {
  useFailoverConfig,
  useFailoverEdgeConfirm,
  useFailoverPlan,
  useFailoverRestore,
  useFailoverRun,
  useFailoverScaleHome,
  useFailoverState,
  type FailoverPlanView,
} from "@/lib/api";

const CUSTOMER_NAMESPACES = ["default", "dynamic-sites", "redis-actual"];

export default function FailoverPanel() {
  const dest = useFailoverConfig();
  const live = useFailoverState();
  const planMut = useFailoverPlan();
  const runMut = useFailoverRun();
  const confirm = useFailoverEdgeConfirm();
  const scale = useFailoverScaleHome();
  const restore = useFailoverRestore();
  const [namespace, setNamespace] = useState("default");
  const [rewrites, setRewrites] = useState<Array<{ rule: string; to: unknown }>>([]);
  const plan = planMut.data;
  const active = live.data?.failedOverTo;
  const selection = { kind: "namespace" as const, namespace };

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
        {active && (
          <ActiveFailover
            snippet={runMut.data?.edgeChange.snippet}
            revert={runMut.data?.edgeChange.revertSnippet}
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

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Selection</h2>
          <p className="text-xs text-muted-foreground">
            Customer apps live in default, dynamic-sites, and redis-actual. One namespace per run.
          </p>
          <div className="flex flex-wrap gap-2">
            {CUSTOMER_NAMESPACES.map((ns) => (
              <button
                key={ns}
                type="button"
                onClick={() => setNamespace(ns)}
                className={`rounded-md border px-2.5 py-1 font-mono text-2xs ${namespace === ns ? "border-[var(--accent-primary)] bg-[var(--accent-dim)] text-[var(--accent-soft)]" : "border-[var(--border-subtle)] text-[var(--fg-secondary)]"}`}
              >
                {ns}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" disabled={planMut.isPending} onClick={() => planMut.mutate({ selection, acceptedRewrites: rewrites })}>
            Preview plan
          </Button>
        </section>

        {plan && <PlanBody plan={plan} onAccept={accept} accepted={rewrites} />}

        {plan && (
          <div className="flex flex-col gap-2">
            <Button size="sm" disabled={plan.blockers.length > 0 || runMut.isPending} onClick={() => runMut.mutate({ selection, acceptedRewrites: rewrites })}>
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
        v1 does not SSH into haproxy. Paste the cutover on root@159.203.36.138, then confirm.
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
