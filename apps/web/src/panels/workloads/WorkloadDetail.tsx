import { ContainerCards, summarizeContainers } from "@/panels/components/ContainerCards";
import { Field } from "@/panels/components/Field";
import { SectionCard } from "@/panels/components/SectionCard";
import { MetaChips } from "@/panels/components/MetaChips";
import { RelatedResources } from "@/panels/components/RelatedResources";
import {
  workloadSpecFields,
  workloadContainers,
  volumeClaimTemplateSummaries,
  jobConditionSummaries,
  cronJobActiveNames,
} from "./workloadsDisplay";
import type { Workload, WorkloadKind, StatefulSet, Job, CronJob } from "./types";

/** Store (plural) kind → singular sourceKind expected by RelatedResources. */
const SINGULAR: Record<WorkloadKind, string> = {
  statefulsets: "statefulset",
  daemonsets: "daemonset",
  jobs: "job",
  cronjobs: "cronjob",
};

/** Expanded detail for one workload row (all four kinds). */
export function WorkloadDetail({ workload, kind }: { workload: Workload; kind: WorkloadKind }) {
  const fields = workloadSpecFields(workload, kind);
  const containers = summarizeContainers(workloadContainers(workload, kind));

  return (
    <div className="space-y-4">
      {/* SPEC */}
      <div className="space-y-2">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">Spec</h3>
        <dl className="grid max-w-3xl grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          {fields.map((f) => (
            <Field key={f.label} label={f.label}>{f.value}</Field>
          ))}
        </dl>
        {containers.length > 0 && (
          <div className="pt-1">
            <ContainerCards containers={containers} />
          </div>
        )}
      </div>

      {kind === "statefulsets" && <VolumeClaimTemplates sts={workload as StatefulSet} />}
      {kind === "jobs" && <JobConditions job={workload as Job} />}
      {kind === "cronjobs" && <ActiveJobs cron={workload as CronJob} />}

      <MetaChips title="Labels" entries={workload.metadata.labels} />
      <MetaChips title="Annotations" entries={workload.metadata.annotations} />

      <RelatedResources sourceKind={SINGULAR[kind]} source={workload as unknown as Record<string, any>} />
    </div>
  );
}

function VolumeClaimTemplates({ sts }: { sts: StatefulSet }) {
  const vcts = volumeClaimTemplateSummaries(sts);
  if (vcts.length === 0) return null;
  return (
    <SectionCard title="Volume Claim Templates" count={vcts.length}>
      <div className="flex flex-col gap-1.5">
        {vcts.map((v) => (
          <div key={v.name} className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span className="text-foreground/90">{v.name}</span>
            <span>·</span>
            <span>{v.storage}</span>
            <span>·</span>
            <span>{v.storageClass}</span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function JobConditions({ job }: { job: Job }) {
  const conds = jobConditionSummaries(job);
  if (conds.length === 0) return null;
  return (
    <SectionCard title="Conditions" count={conds.length}>
      <div className="flex flex-col gap-1.5">
        {conds.map((c, i) => (
          <div key={`${c.type}-${i}`} className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="font-mono text-foreground/90">{c.type}={c.status}</span>
            {c.reason && <span className="text-muted-foreground">{c.reason}</span>}
            {c.message && <span className="text-muted-foreground">{c.message}</span>}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function ActiveJobs({ cron }: { cron: CronJob }) {
  const names = cronJobActiveNames(cron);
  if (names.length === 0) return null;
  return (
    <SectionCard title="Active Jobs" count={names.length}>
      <div className="flex flex-col gap-1">
        {names.map((n) => (
          <span key={n} className="font-mono text-[11px] text-muted-foreground">{n}</span>
        ))}
      </div>
    </SectionCard>
  );
}
