import { Server, User, Users } from "lucide-react";
import type { PolicyRule, Subject } from "../types";
import type { Grant } from "../types";
import { RuleRow } from "./RuleRow";

interface Props {
  roleName: string;
  roleKind: "Role" | "ClusterRole";
  roleNamespace?: string;
  rules: PolicyRule[];
  boundSubjects: { subject: Subject; bindingName: string; scope: Grant["scope"] }[];
}

function subjectIcon(kind: string | undefined) {
  if (kind === "Group") return Users;
  if (kind === "ServiceAccount") return Server;
  return User;
}

export function RoleDetail({ roleName, roleKind, roleNamespace, rules, boundSubjects }: Props) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-1">
        <span className="break-all font-[var(--font-mono)] text-[18px] font-semibold text-[var(--fg-primary)]">
          {roleName}
        </span>
        <span className="text-[13px] text-[var(--fg-tertiary)]">
          {roleKind === "Role" ? `Role · ${roleNamespace ?? ""}` : "ClusterRole"}
        </span>
      </div>

      <div className="flex flex-col gap-[3px]">
        <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
          BOUND TO
        </span>
        <span className="text-[12.5px] text-[var(--fg-tertiary)]">
          Subjects that receive this role
        </span>
      </div>
      {boundSubjects.length === 0 ? (
        <p className="text-[12px] text-[var(--fg-tertiary)]">No subjects are bound to this role.</p>
      ) : (
        <div className="flex flex-col gap-[3px] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-2">
          {boundSubjects.map((b, i) => {
            const Icon = subjectIcon(b.subject.kind);
            return (
              <div key={`${b.bindingName}:${i}`} className="flex flex-wrap items-center gap-x-[11px] gap-y-1 px-[11px] py-[9px]">
                <Icon className="size-[15px] shrink-0 text-[var(--fg-tertiary)]" />
                <span className="break-all font-[var(--font-mono)] text-[13px] text-[var(--fg-primary)]">
                  {b.subject.name}
                </span>
                <span className="break-words text-[11px] text-[var(--fg-tertiary)]">
                  {b.subject.kind}
                  {b.subject.namespace ? ` · ${b.subject.namespace}` : ""} · via {b.bindingName}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-[7px]">
        <span className="font-[var(--font-mono)] text-[10px] tracking-[1px] text-[var(--fg-tertiary)]">
          RULES
        </span>
        <span className="font-[var(--font-mono)] text-[10px] text-[var(--fg-tertiary)]">
          {rules.length}
        </span>
        <div className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>
      <div className="flex flex-col gap-2">
        {rules.map((r, i) => (
          <RuleRow key={i} rule={r} />
        ))}
      </div>
    </div>
  );
}
