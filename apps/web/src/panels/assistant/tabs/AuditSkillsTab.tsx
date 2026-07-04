// apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx
// Audits tab — the launcher for HELM-20 audit skills. Each card is a pure
// launcher: Run hands off `/rigel-<kind>-audit` to a fresh chat thread, and
// Claude Code expands the slash command into the matching SKILL.md, which
// shells out to the `rigel-audit` CLI (single, shared detection path) and
// walks the findings with the user. The user's chat bubble shows the friendly
// `runLabel`; the slash command is what's actually sent to the model.
import { ShieldCheck, Gauge, HeartPulse, type LucideIcon } from "lucide-react";
import { handoffToChat } from "@/lib/chatHandoff";
import { AuditSkillCard } from "../audits/AuditSkillCard";

interface AuditSkill {
  key: "reliability" | "security" | "performance";
  title: string;
  Icon: LucideIcon;
  description: string;
  /** Friendly text shown in the chat bubble in place of the raw slash command. */
  runLabel: string;
}

const AUDIT_SKILLS: AuditSkill[] = [
  {
    key: "reliability",
    title: "Reliability",
    Icon: HeartPulse,
    description:
      "Single replicas, missing probes, PodDisruptionBudgets, anti-affinity, resource requests, mutable image tags, hostPath volumes.",
    runLabel:
      "Run the reliability audit — check single replicas, missing probes, PodDisruptionBudgets, anti-affinity, resource requests, mutable image tags, and hostPath volumes.",
  },
  {
    key: "security",
    title: "Security",
    Icon: ShieldCheck,
    description:
      "Privileged containers, host namespaces, root users, privilege escalation, added capabilities, writable root filesystems, host ports.",
    runLabel:
      "Run the security audit — check privileged containers, host namespaces, root users, privilege escalation, added capabilities, writable root filesystems, and host ports.",
  },
  {
    key: "performance",
    title: "Performance",
    Icon: Gauge,
    description:
      "Missing memory limits, missing autoscaling, CPU throttling, and memory pressure. Metrics checks need a Prometheus/VictoriaMetrics backend.",
    runLabel:
      "Run the performance audit — check missing memory limits, missing autoscaling, CPU throttling, and memory pressure (metrics-backed where a backend is available).",
  },
];

export function AuditSkillsTab() {
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
        {AUDIT_SKILLS.map((skill) => (
          <AuditSkillCard
            key={skill.key}
            title={skill.title}
            description={skill.description}
            Icon={skill.Icon}
            status="live"
            onRun={() =>
              handoffToChat(`/rigel-${skill.key}-audit`, { newThread: true, displayText: skill.runLabel })
            }
          />
        ))}
      </div>
    </div>
  );
}
