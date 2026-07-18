import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faShieldCheck, faGauge, faHeartPulse } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { canRunAudit, type AuditKind } from "@rigel/k8s";
import { handoffToChat } from "@/lib/chatHandoff";
import { AuditSkillCard } from "../audits/AuditSkillCard";
import { useAuditEntitlement } from "../audits/useAuditEntitlement";
import { useEntitlement } from "@/shell/useEntitlement";
import { useAccount } from "@/shell/useAccount";

interface AuditSkill {
  key: AuditKind;
  title: string;
  Icon: IconDefinition;
  description: string;
  runLabel: string;
}

const AUDIT_SKILLS: AuditSkill[] = [
  {
    key: "reliability",
    title: "Reliability",
    Icon: faHeartPulse,
    description:
      "Single replicas, missing probes, PodDisruptionBudgets, anti-affinity, resource requests, mutable image tags, hostPath volumes.",
    runLabel:
      "Run the reliability audit — check single replicas, missing probes, PodDisruptionBudgets, anti-affinity, resource requests, mutable image tags, and hostPath volumes.",
  },
  {
    key: "security",
    title: "Security",
    Icon: faShieldCheck,
    description:
      "Privileged containers, host namespaces, root users, privilege escalation, added capabilities, writable root filesystems, host ports.",
    runLabel:
      "Run the security audit — check privileged containers, host namespaces, root users, privilege escalation, added capabilities, writable root filesystems, and host ports.",
  },
  {
    key: "performance",
    title: "Performance",
    Icon: faGauge,
    description:
      "Missing memory limits, missing autoscaling, CPU throttling, and memory pressure. Metrics checks need a Prometheus/VictoriaMetrics backend.",
    runLabel:
      "Run the performance audit — check missing memory limits, missing autoscaling, CPU throttling, and memory pressure (metrics-backed where a backend is available).",
  },
];

export function AuditSkillsTab() {
  const entitlement = useAuditEntitlement();
  const { upgrade } = useEntitlement();
  const { orgs } = useAccount();
  const personalOrgId = orgs.find((o) => o.kind === "personal")?.id;

  return (
    <div className="space-y-3.5">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[var(--fg-primary)]">Audit skills</p>
        <p className="text-xs text-[var(--fg-tertiary)]">
          Focused, deterministic audits of your cluster. Run one and Rigel walks the findings with you in chat,
          with a one-click fix for each.
        </p>
      </div>

      <div className="space-y-2.5">
        {AUDIT_SKILLS.map((skill) => {
          const gate = canRunAudit(skill.key, entitlement);
          return (
            <AuditSkillCard
              key={skill.key}
              title={skill.title}
              description={skill.description}
              Icon={skill.Icon}
              locked={
                gate.allowed
                  ? undefined
                  : {
                      reason: gate.reason ?? "This audit requires an upgrade.",
                      onUpgrade: personalOrgId ? () => upgrade(personalOrgId) : undefined,
                    }
              }
              onRun={
                gate.allowed
                  ? () => handoffToChat(`/rigel-${skill.key}-audit`, { newThread: true, displayText: skill.runLabel })
                  : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}
