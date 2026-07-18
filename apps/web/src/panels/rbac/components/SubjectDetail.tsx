import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faLayerGroup,
  faCube,
  faShieldExclamation,
  faMessage,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import type { Grant, ListSubject } from "../types";
import { grantRisk } from "../risk";
import { BindingCard } from "./BindingCard";

interface Props {
  subject: ListSubject;
  grants: Grant[];
  onAsk: (subject: ListSubject) => void;
  onEditBinding?: (grant: Grant) => void;
  onAddSubject?: (grant: Grant) => void;
  onEditBindingYaml?: (grant: Grant) => void;
  onDeleteBinding?: (grant: Grant) => void;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function SummaryItem({
  Icon,
  text,
  danger,
}: {
  Icon: IconDefinition;
  text: string;
  danger?: boolean;
}) {
  const color = danger ? "text-[var(--status-failed)]" : "text-[var(--fg-primary)]";
  return (
    <div className="flex items-center gap-2">
      <FontAwesomeIcon icon={Icon} className={`size-[15px] ${color}`} />
      <span className={`text-xs font-semibold ${color}`}>{text}</span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-[5px]">
      <span className="size-[7px] rounded-full" style={{ background: color }} />
      <span className="text-2xs text-[var(--fg-tertiary)]">{label}</span>
    </div>
  );
}

export function SubjectDetail({
  subject,
  grants,
  onAsk,
  onEditBinding,
  onAddSubject,
  onEditBindingYaml,
  onDeleteBinding,
}: Props) {
  const namespaces = new Set(
    grants.filter((g) => g.scope.kind === "Namespaced").map((g) => (g.scope as { namespace: string }).namespace),
  );
  const hasCluster = grants.some((g) => g.scope.kind === "Cluster");
  const dangerousCount = grants.filter((g) => grantRisk(g.rules) === "dangerous").length;
  const scopeText =
    hasCluster && namespaces.size > 0
      ? `${plural(namespaces.size, "namespace", "namespaces")} + cluster`
      : hasCluster
        ? "cluster"
        : plural(namespaces.size, "namespace", "namespaces");

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-[14px] gap-y-1">
          <span className="break-all font-[var(--font-mono)] text-lg font-semibold text-[var(--fg-primary)]">
            {subject.name}
          </span>
          <span className="text-xs text-[var(--fg-tertiary)]">
            {subject.namespace ? `${subject.kind} · ${subject.namespace}` : subject.kind}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onAsk(subject)}
          className="flex shrink-0 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-strong)] px-[15px] py-[9px] text-xs text-[var(--fg-primary)] hover:bg-white/[0.04]"
        >
          <FontAwesomeIcon icon={faMessage} className="size-[14px]" />
          Ask Rigel about access
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-[22px] gap-y-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-4 py-3">
        <SummaryItem Icon={faLayerGroup} text={plural(grants.length, "role bound", "roles bound")} />
        <span className="h-4 w-px bg-[var(--border-strong)]" />
        <SummaryItem Icon={faCube} text={scopeText} />
        <span className="h-4 w-px bg-[var(--border-strong)]" />
        <SummaryItem
          Icon={faShieldExclamation}
          text={plural(dangerousCount, "dangerous grant", "dangerous grants")}
          danger={dangerousCount > 0}
        />
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div className="flex flex-col gap-[3px]">
          <span className="font-[var(--font-mono)] text-2xs font-semibold tracking-[1px] text-[var(--fg-secondary)]">
            ACCESS
          </span>
          <span className="text-xs text-[var(--fg-tertiary)]">
            Roles bound to this subject, and the rules they grant
          </span>
        </div>
        <div className="flex items-center gap-3">
          <LegendDot color="var(--status-failed)" label="dangerous" />
          <LegendDot color="var(--status-pending)" label="wildcard" />
        </div>
      </div>

      <div className="flex flex-col gap-[14px]">
        {grants.map((g, i) => (
          <BindingCard
            key={`${g.bindingKind}:${g.bindingName}:${i}`}
            grant={g}
            onEdit={onEditBinding}
            onAddSubject={onAddSubject}
            onEditYaml={onEditBindingYaml}
            onDelete={onDeleteBinding}
          />
        ))}
      </div>
    </div>
  );
}
