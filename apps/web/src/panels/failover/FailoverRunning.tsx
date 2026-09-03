import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faXmark, faMinus } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Loader } from "@/components/Loader";
import type { FailoverJobView, FailoverStepStatus, FailoverStepView } from "@/lib/api";

const MARK: Record<Exclude<FailoverStepStatus, "running" | "pending">, { icon: typeof faCheck; color: string }> = {
  done: { icon: faCheck, color: "var(--status-running)" },
  failed: { icon: faXmark, color: "var(--status-failed)" },
  skipped: { icon: faMinus, color: "var(--fg-tertiary)" },
};

function StepMark({ status }: { status: FailoverStepStatus }) {
  if (status === "running") return <Loader size={18} className="text-[var(--accent-primary)]" label="running" />;
  if (status === "pending") {
    return <span className="size-[18px] rounded-full border border-[var(--border-strong)]" aria-hidden />;
  }
  const { icon, color } = MARK[status];
  return (
    <span
      className="flex size-[18px] items-center justify-center rounded-full"
      style={{ backgroundColor: status === "skipped" ? "transparent" : color }}
    >
      <FontAwesomeIcon
        icon={icon}
        aria-hidden
        className="size-2.5"
        style={{ color: status === "skipped" ? color : "var(--fg-inverse)" }}
      />
    </span>
  );
}

function Step({ step }: { step: FailoverStepView }) {
  return (
    <li className="flex items-start gap-3 border-b border-[var(--border-subtle)] py-3 last:border-b-0">
      <StepMark status={step.status} />
      <div className="flex min-w-0 flex-col gap-[3px]">
        <p
          className={`text-sm font-semibold ${step.status === "pending" ? "text-[var(--fg-tertiary)]" : "text-[var(--fg-primary)]"}`}
        >
          {step.label}
        </p>
        {step.detail && <p className="font-mono text-2xs text-[var(--fg-tertiary)]">{step.detail}</p>}
        {step.error && <p className="font-mono text-2xs text-[var(--status-failed)]">{step.error}</p>}
      </div>
    </li>
  );
}

export function FailoverRunning({ job }: { job: FailoverJobView }) {
  if (job.status === "idle") return null;
  const done = job.steps.filter((s) => s.status === "done" || s.status === "skipped").length;

  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3">
      <div className="flex items-center gap-[9px]">
        <h2 className="text-sm font-semibold">
          {job.status === "running" ? "Running" : job.status === "done" ? "Copy is up" : "Run failed"}
        </h2>
        <span className="rounded-[4px] border border-[var(--border-subtle)] bg-white/5 px-[9px] py-[2px] font-mono text-xs font-semibold text-muted-foreground">
          {done}/{job.steps.length}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        A DigitalOcean cluster is coming up. Dump bytes stay on this machine and never appear in the UI.
      </p>
      <ul className="flex flex-col">
        {job.steps.map((s) => (
          <Step key={s.id} step={s} />
        ))}
      </ul>
      {job.error && <p className="text-xs text-[var(--status-failed)]">{job.error}</p>}
    </section>
  );
}
