import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faLink,
  faArrowRight,
  faFileCertificate,
  faCube,
  faPencil,
  faUserPlus,
  faCode,
  faTrashCan,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import type { Grant } from "../types";
import { RuleRow } from "./RuleRow";

function roleRefLabel(grant: Grant): string {
  const kind = grant.roleRef.kind ?? (grant.bindingKind === "RoleBinding" ? "Role" : "ClusterRole");
  return `${kind}/${grant.roleRef.name ?? "—"}`;
}

interface Props {
  grant: Grant;
  onEdit?: (grant: Grant) => void;
  onAddSubject?: (grant: Grant) => void;
  onEditYaml?: (grant: Grant) => void;
  onDelete?: (grant: Grant) => void;
}

function IconBtn({
  label,
  Icon,
  onClick,
  danger,
}: {
  label: string;
  Icon: IconDefinition;
  onClick?: () => void;
  danger?: boolean;
}) {
  if (!onClick) return null;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] border transition-colors ${
        danger
          ? "border-[var(--status-failed)]/40 bg-[var(--status-failed)]/10 text-[var(--status-failed)] hover:bg-[var(--status-failed)]/20"
          : "border-[var(--border-strong)] bg-[var(--surface-sunken)] text-[var(--fg-secondary)] hover:bg-white/[0.08] hover:text-[var(--fg-primary)]"
      }`}
    >
      <FontAwesomeIcon icon={Icon} className="size-[14px]" />
    </button>
  );
}

export function BindingCard({ grant, onEdit, onAddSubject, onEditYaml, onDelete }: Props) {
  const rules = grant.rules;
  return (
    <div className="flex flex-col gap-[13px] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
          <FontAwesomeIcon icon={faLink} className="size-[15px] shrink-0 text-[var(--fg-tertiary)]" />
          <span className="break-all font-[var(--font-mono)] text-sm font-semibold text-[var(--fg-primary)]">
            {grant.bindingName}
          </span>
          <span className="flex shrink-0 items-center gap-[5px] rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-white/[0.05] px-2 py-[2px]">
            <FontAwesomeIcon icon={faCube} className="size-[10px] text-[var(--fg-tertiary)]" />
            <span className="text-2xs font-medium text-[var(--fg-secondary)]">
              {grant.scope.kind === "Namespaced" ? "Namespaced" : "Cluster"}
            </span>
            {grant.scope.kind === "Namespaced" && (
              <span className="font-[var(--font-mono)] text-2xs text-[var(--fg-tertiary)]">
                {grant.scope.namespace}
              </span>
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-[9px]">
          <span className="text-xs text-[var(--fg-tertiary)]">grants</span>
          <FontAwesomeIcon icon={faArrowRight} className="size-[14px] text-[var(--fg-tertiary)]" />
          <span className="flex items-center gap-[6px] rounded-[var(--radius-sm)] border border-[var(--accent-primary)]/25 bg-[var(--accent-dim)] px-[9px] py-[3px]">
            <FontAwesomeIcon icon={faFileCertificate} className="size-[12px] text-[var(--accent-primary)]" />
            <span className="font-[var(--font-mono)] text-xs font-semibold text-[var(--accent-primary)]">
              {roleRefLabel(grant)}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-[6px]">
          <IconBtn label="Edit binding" Icon={faPencil} onClick={onEdit && (() => onEdit(grant))} />
          <IconBtn label="Add subject" Icon={faUserPlus} onClick={onAddSubject && (() => onAddSubject(grant))} />
          <IconBtn label="Edit YAML" Icon={faCode} onClick={onEditYaml && (() => onEditYaml(grant))} />
          <IconBtn label="Delete binding" Icon={faTrashCan} danger onClick={onDelete && (() => onDelete(grant))} />
        </div>
      </div>

      <div className="flex items-center gap-[7px]">
        <span className="font-[var(--font-mono)] text-3xs tracking-[1px] text-[var(--fg-tertiary)]">
          RULES
        </span>
        <span className="font-[var(--font-mono)] text-3xs text-[var(--fg-tertiary)]">
          {rules.length}
        </span>
        <div className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>

      {rules.length === 0 ? (
        <p className="text-xs text-[var(--fg-tertiary)]">
          Role not found in scope (rules unavailable).
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {rules.map((r, i) => (
            <RuleRow key={i} rule={r} />
          ))}
        </div>
      )}
    </div>
  );
}
