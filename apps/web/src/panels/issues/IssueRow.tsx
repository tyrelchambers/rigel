import { useState } from "react";
import { useNavigate } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangle } from "@awesome.me/kit-6050953220/icons/classic/solid";
import type {
  Issue,
  IssueCategory,
  IssueGroup,
  IssueSeverity,
  IssueSubject,
} from "@rigel/k8s/src/issues/types";
import type { ActionBlock } from "@/lib/api";
import { compactAge } from "@/lib/time";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ListRow } from "@/panels/components/ListRow";
import { SectionLabel } from "@/panels/components/MetaCard";
import { useRepoLink } from "@/panels/gitops/gitApi";
import { issueFixAction, openIssueSubject, runDiagnose } from "./issueActions";

const CATEGORY_LABELS: Record<IssueCategory, string> = {
  runtime: "Runtime",
  scheduling: "Scheduling",
  networking: "Networking",
  config: "Config",
  storage: "Storage",
  controlPlane: "Control plane",
  certs: "Certs",
};

export const SEVERITY_LABELS: Record<IssueSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

export function SeverityGlyph({ severity, dimmed }: { severity: IssueSeverity; dimmed?: boolean }) {
  const label = SEVERITY_LABELS[severity];
  if (severity === "warning") {
    return (
      <FontAwesomeIcon
        icon={faTriangle}
        aria-label={label}
        className={`size-2.5 shrink-0 ${dimmed ? "text-[var(--fg-tertiary)]" : "text-[var(--status-pending)]"}`}
      />
    );
  }
  if (severity === "info") {
    return (
      <span
        aria-label={label}
        role="img"
        className={`size-2.5 shrink-0 rounded-full border-2 ${dimmed ? "border-[var(--fg-tertiary)]" : "border-[var(--accent-primary)]"}`}
      />
    );
  }
  return (
    <span
      aria-label={label}
      role="img"
      className={`size-2.5 shrink-0 rounded-full ${dimmed ? "bg-[var(--fg-tertiary)]" : "bg-[var(--status-failed)]"}`}
    />
  );
}

export function KindBadge({ kind, dimmed }: { kind: string; dimmed?: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-sm border border-[var(--border-subtle)] px-1.5 py-px font-mono text-3xs font-semibold tracking-wider uppercase text-[var(--fg-tertiary)] ${dimmed ? "bg-[var(--surface-primary)]" : "bg-[var(--surface-elevated)]"}`}
    >
      {kind}
    </span>
  );
}

function CategoryPill({ category, dimmed }: { category: IssueCategory; dimmed?: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-sm border border-[var(--border-subtle)] px-1.5 py-px text-3xs font-bold text-[var(--fg-secondary)] ${dimmed ? "" : "bg-white/5"}`}
    >
      {CATEGORY_LABELS[category]}
    </span>
  );
}

function subjectLabel(subject: IssueSubject): string {
  return subject.namespace ? `${subject.namespace} / ${subject.name}` : subject.name;
}

function ActionButton({
  label,
  onClick,
  accent,
}: {
  label: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        accent
          ? "shrink-0 rounded-md border border-[var(--accent-primary)] bg-[var(--accent-dim)] px-3 py-1.5 text-2xs font-bold text-[var(--accent-soft)] transition-colors hover:border-[var(--accent-hover)]"
          : "shrink-0 rounded-md border border-[var(--border-strong)] bg-[var(--surface-elevated)] px-3 py-1.5 text-2xs font-bold text-[var(--fg-secondary)] transition-colors hover:text-[var(--fg-primary)]"
      }
    >
      {label}
    </button>
  );
}

function ExplainSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  );
}

function repoScaleEdit(issue: Issue): { op: "scale"; replicas: number } | undefined {
  if (issue.subject.kind !== "Deployment" || issue.fix?.command[0] !== "scale") return undefined;
  const flag = issue.fix.command.find((a) => a.startsWith("--replicas="));
  if (!flag) return undefined;
  const replicas = Number(flag.slice("--replicas=".length));
  return Number.isInteger(replicas) && replicas >= 0 ? { op: "scale", replicas } : undefined;
}

export interface IssueRowProps {
  group: IssueGroup;
  isOpen: boolean;
  onToggle: () => void;
  onMute: (fingerprint: string, snooze: { hours: number } | null) => void;
}

export function IssueRow({ group, isOpen, onToggle, onMute }: IssueRowProps) {
  const navigate = useNavigate();
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const lead = group.lead;
  const rolledUp = group.members.length > 1;
  const fix = issueFixAction(lead);
  const scaleEdit = repoScaleEdit(lead);
  const repoLink = useRepoLink(
    scaleEdit ? lead.subject.namespace : null,
    scaleEdit ? lead.subject.name : null,
  );
  const link = scaleEdit && repoLink.data?.linked ? repoLink.data.link : null;

  function runFix() {
    if (!fix) return;
    setPendingAction({
      kind: "command",
      label: fix.label,
      args: fix.command,
      destructive: fix.destructive,
      namespace: lead.subject.namespace,
    });
  }

  function runFixInGit() {
    if (!link || !scaleEdit) return;
    setPendingAction({
      kind: "proposeRepoFix",
      label: "Fix in Git",
      name: lead.subject.name,
      namespace: lead.subject.namespace,
      resourceKind: "deployment",
      source: link.source,
      title: `${lead.title}: ${subjectLabel(lead.subject)}`,
      body: `${lead.whatsWrong}\n\n${lead.nextStep}`,
      edit: scaleEdit,
    });
  }

  const rowMenu = (
    <>
      <ContextMenuItem onClick={() => openIssueSubject(navigate, lead)}>Open</ContextMenuItem>
      <ContextMenuItem onClick={() => runDiagnose(lead)}>Diagnose</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onMute(lead.fingerprint, { hours: 1 })}>Snooze 1 hour</ContextMenuItem>
      <ContextMenuItem onClick={() => onMute(lead.fingerprint, { hours: 24 })}>Snooze 24 hours</ContextMenuItem>
      <ContextMenuItem onClick={() => onMute(lead.fingerprint, { hours: 24 * 7 })}>Snooze 7 days</ContextMenuItem>
      <ContextMenuItem onClick={() => onMute(lead.fingerprint, null)}>Mute indefinitely</ContextMenuItem>
    </>
  );

  const expanded = (
    <div className="flex flex-col gap-4">
      <div className="flex gap-8">
        <ExplainSection label="WHAT'S WRONG">
          <p className="text-xs leading-relaxed text-[var(--fg-secondary)]">{lead.whatsWrong}</p>
        </ExplainSection>
        <ExplainSection label="NEXT STEP">
          <p className="text-xs leading-relaxed text-[var(--fg-secondary)]">{lead.nextStep}</p>
        </ExplainSection>
      </div>

      {lead.evidence && (
        <ExplainSection label="EVIDENCE">
          <pre className="overflow-x-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-[var(--fg-secondary)]">
            {lead.evidence}
          </pre>
        </ExplainSection>
      )}

      {lead.related.length > 0 && (
        <ExplainSection label="RELATED">
          <div className="flex flex-wrap items-center gap-2">
            {lead.related.map((ref) => (
              <button
                key={`${ref.kind}/${ref.namespace}/${ref.name}`}
                type="button"
                onClick={() => openIssueSubject(navigate, { ...lead, subject: ref })}
                className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-2.5 py-1.5 transition-colors hover:border-[var(--border-strong)]"
              >
                <span className="text-2xs font-bold text-[var(--fg-tertiary)]">{ref.kind}</span>
                <span className="font-mono text-2xs text-[var(--fg-secondary)]">{subjectLabel(ref)}</span>
              </button>
            ))}
          </div>
        </ExplainSection>
      )}

      {rolledUp && (
        <ExplainSection label="AFFECTED">
          <div className="flex flex-col rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
            {group.members.map((member, i) => (
              <div
                key={member.fingerprint}
                className={`flex items-center gap-2.5 px-3 py-2.5 ${i > 0 ? "border-t border-[var(--border-subtle)]" : ""}`}
              >
                <KindBadge kind={member.subject.kind} />
                <span className="truncate font-mono text-2xs text-[var(--fg-primary)]">
                  {member.subject.name}
                </span>
                {member.related[0] && (
                  <span className="truncate text-2xs text-[var(--fg-tertiary)]">
                    needs {subjectLabel(member.related[0])}
                  </span>
                )}
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => openIssueSubject(navigate, member)}
                  className="shrink-0 rounded-md border border-[var(--border-strong)] bg-[var(--surface-elevated)] px-2 py-1 text-3xs font-bold text-[var(--fg-secondary)] transition-colors hover:text-[var(--fg-primary)]"
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        </ExplainSection>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <ActionButton label="Open" onClick={() => openIssueSubject(navigate, lead)} />
        <ActionButton label="Diagnose" onClick={() => runDiagnose(lead)} />
        {fix && <ActionButton label={fix.label} onClick={runFix} accent />}
        {link && <ActionButton label="Fix in Git" onClick={runFixInGit} />}
      </div>
    </div>
  );

  return (
    <>
      <ListRow
        rowKey={group.key}
        isOpen={isOpen}
        onToggle={onToggle}
        contextMenu={rowMenu}
        expandedContent={expanded}
      >
        <SeverityGlyph severity={lead.severity} />

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={onToggle}
              className="shrink-0 text-sm leading-tight font-semibold text-[var(--fg-primary)] hover:underline"
            >
              {lead.title}
            </button>
            <CategoryPill category={lead.category} />
            <span className="truncate text-xs text-[var(--fg-tertiary)]" title={lead.cause}>
              {lead.cause}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <KindBadge kind={lead.subject.kind} />
            {rolledUp ? (
              <span className="text-2xs font-bold text-[var(--fg-secondary)]">
                {group.members.length} affected
              </span>
            ) : (
              <span className="truncate font-mono text-2xs text-[var(--fg-secondary)]">
                {subjectLabel(lead.subject)}
              </span>
            )}
          </div>
        </div>

        <span className="shrink-0 font-mono text-2xs text-[var(--fg-tertiary)]">
          {compactAge(lead.onsetAt, { invalid: "" })}
        </span>

        <ActionButton label="Diagnose" onClick={() => runDiagnose(lead)} />
      </ListRow>

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </>
  );
}

export function MutedIssueRow({ issue, onUnmute }: { issue: Issue; onUnmute: () => void }) {
  return (
    <div className="relative flex items-center gap-2 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-primary)] px-2.5 py-2">
      <SeverityGlyph severity={issue.severity} dimmed />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0 text-sm leading-tight font-semibold text-[var(--fg-secondary)]">
            {issue.title}
          </span>
          <CategoryPill category={issue.category} dimmed />
          <span className="truncate text-xs text-[var(--fg-tertiary)]" title={issue.cause}>
            {issue.cause}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <KindBadge kind={issue.subject.kind} dimmed />
          <span className="truncate font-mono text-2xs text-[var(--fg-tertiary)]">
            {subjectLabel(issue.subject)}
          </span>
        </div>
      </div>

      <span className="shrink-0 font-mono text-2xs text-[var(--fg-tertiary)]">
        {compactAge(issue.onsetAt, { invalid: "" })}
      </span>

      <button
        type="button"
        onClick={onUnmute}
        className="shrink-0 px-2.5 py-1.5 text-2xs font-bold text-[var(--accent-primary)] hover:underline"
      >
        Unmute
      </button>
    </div>
  );
}
