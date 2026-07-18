import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell, faRobot, faCalendarClock, faCodePullRequest, faShieldCheck, faSparkles, faStethoscope, faBolt } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import { useUpgrade } from "@/shell/UpgradeContext";

const FEATURES = [
  {
    icon: faBolt,
    title: "Autonomous remediation",
    desc: "Applies safe fixes automatically — or holds them for your approval. Your call, per cluster.",
  },
  {
    icon: faStethoscope,
    title: "Incident diagnosis",
    desc: "An LLM investigates what actually broke and why, with a plain-English verdict.",
  },
  {
    icon: faBell,
    title: "Notifications",
    desc: "Get pinged on Signal, Matrix, Slack, or Discord the moment something needs you.",
  },
  {
    icon: faCodePullRequest,
    title: "Autofix PRs",
    desc: "Opens GitHub pull requests that fix misconfigurations, ready for your review.",
  },
  {
    icon: faCalendarClock,
    title: "Scheduled digests",
    desc: "Daily or weekly summaries of what changed and what still needs attention.",
  },
  {
    icon: faShieldCheck,
    title: "Audits",
    desc: "On-demand reliability, security, and performance checks across your workloads.",
  },
];

export function AssistantGate() {
  const { openUpgrade } = useUpgrade();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-10 py-12 text-center">
        <div className="flex size-16 items-center justify-center rounded-full bg-[var(--accent-dim)]">
          <FontAwesomeIcon icon={faRobot} className="size-8 text-[var(--accent-primary)]" />
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-dim)] px-3 py-1">
          <FontAwesomeIcon icon={faSparkles} className="size-3 text-[var(--accent-primary)]" />
          <span className="font-mono text-2xs font-semibold tracking-wider text-[var(--accent-primary)]">PRO</span>
        </span>
        <h2 className="font-heading text-3xl font-bold text-[var(--fg-primary)]">Let Rigel run your cluster</h2>
        <p className="max-w-xl text-base leading-relaxed text-[var(--fg-secondary)]">
          The in-cluster agent watches around the clock — catching problems, diagnosing the cause, and applying the
          fixes you approve, even while you're away from the app.
        </p>
        <Button className="mt-1" onClick={openUpgrade}>
          <FontAwesomeIcon icon={faBolt} className="size-4" />
          Upgrade to Pro
        </Button>
        <span className="text-xs text-[var(--fg-tertiary)]">Per seat · cancel anytime</span>
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => {
          const Icon = f.icon;
          return (
            <div
              key={f.title}
              className="flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-5"
            >
              <div className="flex size-10 items-center justify-center rounded-[10px] bg-[var(--accent-dim)]">
                <FontAwesomeIcon icon={Icon} className="size-5 text-[var(--accent-primary)]" />
              </div>
              <p className="font-heading text-sm font-semibold text-[var(--fg-primary)]">{f.title}</p>
              <p className="text-xs leading-relaxed text-[var(--fg-secondary)]">{f.desc}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
