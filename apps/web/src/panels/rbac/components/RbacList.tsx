import { User, Users, Server, FileBadge } from "lucide-react";
import { TabBar, Tab } from "@/components/ui/Tabs";
import type { ListSubject, RbacView } from "../types";

/** A role list item (namespaced Role or ClusterRole) for the Roles view. */
export interface RoleItem {
  key: string;
  kind: "Role" | "ClusterRole";
  name: string;
  namespace?: string;
  dangerous: boolean;
}

interface Props {
  view: RbacView;
  onViewChange: (view: RbacView) => void;
  subjects: ListSubject[];
  roleItems: RoleItem[];
  selectedKey: string | null;
  onSelectSubject: (s: ListSubject) => void;
  onSelectRole: (r: RoleItem) => void;
}

function subjectIcon(kind: string) {
  if (kind === "Group") return Users;
  if (kind === "ServiceAccount") return Server;
  return User;
}

function Row({
  selected,
  dangerous,
  Icon,
  name,
  sub,
  onClick,
}: {
  selected: boolean;
  dangerous: boolean;
  Icon: typeof User;
  name: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-[11px] rounded-[var(--radius-md)] border px-[11px] py-[10px] text-left transition-colors ${
        selected
          ? "border-[var(--accent-primary)]/35 bg-[var(--accent-dim)]"
          : "border-transparent hover:bg-white/[0.04]"
      }`}
    >
      <Icon className="size-[15px] shrink-0 text-[var(--fg-tertiary)]" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-[var(--font-mono)] text-[13px] font-medium text-[var(--fg-primary)]">
          {name}
        </span>
        {sub && <span className="truncate text-[11px] text-[var(--fg-tertiary)]">{sub}</span>}
      </div>
      <span className="flex-1" />
      {dangerous && <span className="size-[7px] shrink-0 rounded-full bg-[var(--status-failed)]" />}
    </button>
  );
}

export function RbacList({
  view,
  onViewChange,
  subjects,
  roleItems,
  selectedKey,
  onSelectSubject,
  onSelectRole,
}: Props) {
  return (
    <div className="flex w-[452px] shrink-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-[14px] py-[13px]">
        <div className="flex items-center gap-2">
          <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
            {view === "subjects" ? "SUBJECTS" : "ROLES"}
          </span>
          <span className="font-[var(--font-mono)] text-[11px] text-[var(--fg-tertiary)]">
            {view === "subjects" ? subjects.length : roleItems.length}
          </span>
        </div>
        <TabBar value={view} onValueChange={(v) => onViewChange(v as RbacView)}>
          <Tab value="subjects">Subjects</Tab>
          <Tab value="roles">Roles</Tab>
        </TabBar>
      </div>

      <div className="flex flex-col gap-[3px] overflow-auto p-2">
        {view === "subjects"
          ? subjects.map((s) => (
              <Row
                key={s.key}
                selected={s.key === selectedKey}
                dangerous={s.dangerous}
                Icon={subjectIcon(s.kind)}
                name={s.name}
                sub={s.namespace ? `${s.kind} · ${s.namespace}` : s.kind}
                onClick={() => onSelectSubject(s)}
              />
            ))
          : roleItems.map((r) => (
              <Row
                key={r.key}
                selected={r.key === selectedKey}
                dangerous={r.dangerous}
                Icon={FileBadge}
                name={r.name}
                sub={r.kind === "Role" ? `Role · ${r.namespace ?? ""}` : "ClusterRole"}
                onClick={() => onSelectRole(r)}
              />
            ))}
      </div>
    </div>
  );
}
