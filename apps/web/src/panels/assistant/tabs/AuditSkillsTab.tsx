// apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx
// Audits tab — the launcher for HELM-20 audit skills. Each card is a pure
// launcher: Run hands off `/rigel-<kind>-audit` to a fresh chat thread, and
// Claude Code expands the slash command into the matching SKILL.md, which
// shells out to the `rigel-audit` CLI (single, shared detection path) and
// walks the findings with the user. No web-computed counts here.
import { ShieldCheck, Gauge, HeartPulse } from "lucide-react";
import { handoffToChat } from "@/lib/chatHandoff";
import { AuditSkillCard } from "../audits/AuditSkillCard";

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
        <AuditSkillCard
          title="Reliability"
          description="Single replicas, missing probes, PodDisruptionBudgets, anti-affinity, resource requests, mutable image tags, hostPath volumes."
          Icon={HeartPulse}
          status="live"
          onRun={() => handoffToChat("/rigel-reliability-audit", { newThread: true })}
        />
        <AuditSkillCard
          title="Security"
          description="Privileged containers, root users, missing securityContext, hostPath / hostNetwork, wide RBAC."
          Icon={ShieldCheck}
          status="live"
          onRun={() => handoffToChat("/rigel-security-audit", { newThread: true })}
        />
        <AuditSkillCard
          title="Performance"
          description="CPU throttling, hotspots, slow startups, HPA tuning. Needs a metrics backend."
          Icon={Gauge}
          status="live"
          onRun={() => handoffToChat("/rigel-performance-audit", { newThread: true })}
        />
      </div>
    </div>
  );
}
