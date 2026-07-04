// apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx
// Audits tab — the launcher for HELM-20 audit skills. Reliability is live
// (deterministic engine → chat handoff); Security and Performance are disabled
// "coming soon" cards (future home of premium/locked state, HELM-16). Findings
// are surfaced in chat, so this tab is a launcher, not a report view.
import { ShieldCheck, Gauge, HeartPulse } from "lucide-react";
import { handoffToChat } from "@/lib/chatHandoff";
import { AuditSkillCard } from "../audits/AuditSkillCard";
import { useReliabilityAudit } from "../audits/useReliabilityAudit";
import { buildReliabilityAuditPrompt } from "../audits/auditPrompt";

export function AuditSkillsTab() {
  const { findings, counts } = useReliabilityAudit();

  function runReliability() {
    handoffToChat(buildReliabilityAuditPrompt(findings), { newThread: true });
  }

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
          counts={counts}
          onRun={runReliability}
        />
        <AuditSkillCard
          title="Security"
          description="Privileged containers, root users, missing securityContext, hostPath / hostNetwork, wide RBAC."
          Icon={ShieldCheck}
          status="soon"
        />
        <AuditSkillCard
          title="Performance"
          description="CPU throttling, hotspots, slow startups, HPA tuning. Needs a metrics backend."
          Icon={Gauge}
          status="soon"
        />
      </div>
    </div>
  );
}
