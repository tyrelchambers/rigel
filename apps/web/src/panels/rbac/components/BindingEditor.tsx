import { useEffect, useMemo, useState } from "react";
import { Link2, Plus, X, Code } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { RoleRef, Subject } from "../types";
import { buildBindingYaml } from "../manifest";
import { NamespaceField } from "./NamespaceField";

export interface BindingTarget {
  kind: "RoleBinding" | "ClusterRoleBinding";
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  roleRef: RoleRef;
  subjects: Subject[];
  /** Optional focus hint — scroll/emphasise the subjects section. */
  focusSubjects?: boolean;
}

/** A role the binding can reference, for the roleRef dropdown. */
export interface RoleOption {
  kind: "Role" | "ClusterRole";
  name: string;
  namespace?: string;
}

interface Props {
  target: BindingTarget | null;
  open: boolean;
  onClose: () => void;
  onApply: (result: { yaml: string; label: string }) => void;
  onEditYaml?: () => void;
  /** All roles/clusterroles in scope, used to populate the roleRef dropdown. */
  roleOptions?: RoleOption[];
  /**
   * In create mode, derive a suggested binding name from the chosen roleRef name
   * (recomputed until the user edits the name field by hand). Return "" for no
   * suggestion. Ignored in edit mode.
   */
  nameSuggestion?: (roleRefName: string) => string;
}

const SUBJECT_KINDS = ["ServiceAccount", "User", "Group"] as const;

function selectClass(w: string) {
  return `${w} appearance-none rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[11px] py-[9px] text-[12.5px] text-[var(--fg-primary)] outline-none`;
}

export function BindingEditor({
  target,
  open,
  onClose,
  onApply,
  onEditYaml,
  roleOptions,
  nameSuggestion,
}: Props) {
  const isEdit = target != null && target.name.trim() !== "";
  const [kind, setKind] = useState<"RoleBinding" | "ClusterRoleBinding">(target?.kind ?? "RoleBinding");
  const [name, setName] = useState(target?.name ?? "");
  const [nameTouched, setNameTouched] = useState(false);
  const [namespace, setNamespace] = useState(target?.namespace ?? "default");
  const [roleRef, setRoleRef] = useState<RoleRef>(target?.roleRef ?? { kind: "Role", name: "" });
  const [subjects, setSubjects] = useState<Subject[]>(
    (target?.subjects ?? []).map((s) => ({ ...s })),
  );

  function setSubject(i: number, patch: Partial<Subject>) {
    setSubjects((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  // A RoleBinding may reference a Role (same namespace) or a ClusterRole; a
  // ClusterRoleBinding may only reference a ClusterRole.
  function selectKind(k: "RoleBinding" | "ClusterRoleBinding") {
    setKind(k);
    if (k === "ClusterRoleBinding") setRoleRef((rr) => ({ ...rr, kind: "ClusterRole" }));
  }

  const roleNameOptions = useMemo(() => {
    const wantKind = roleRef.kind ?? "Role";
    let opts = (roleOptions ?? [])
      .filter((o) => o.kind === wantKind && (wantKind === "ClusterRole" || o.namespace === namespace))
      .map((o) => o.name);
    opts = Array.from(new Set(opts)).sort((a, b) => a.localeCompare(b));
    if (roleRef.name && !opts.includes(roleRef.name)) opts = [roleRef.name, ...opts];
    return opts;
  }, [roleOptions, roleRef.kind, roleRef.name, namespace]);

  // Auto-suggest the binding name from the chosen role, until the user edits it.
  useEffect(() => {
    if (isEdit || !nameSuggestion || nameTouched) return;
    setName(nameSuggestion(roleRef.name ?? ""));
  }, [isEdit, nameSuggestion, nameTouched, roleRef.name]);

  const valid = name.trim() !== "" && (roleRef.name ?? "").trim() !== "";

  function apply() {
    const yaml = buildBindingYaml(
      {
        kind,
        name: name.trim(),
        namespace: kind === "RoleBinding" ? namespace.trim() : undefined,
        labels: target?.labels,
        annotations: target?.annotations,
      },
      roleRef,
      subjects,
    );
    onApply({ yaml, label: `Apply ${kind} ${name.trim()}` });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[86vh] w-[calc(100%-2rem)] max-w-[560px]">
        <DialogHeader>
          <DialogIcon>
            <Link2 className="size-[15px] text-[var(--accent-primary)]" />
          </DialogIcon>
          <DialogTitle>{isEdit ? `Edit binding · ${target!.name}` : "New binding"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {isEdit ? (
            <p className="text-[12px] text-[var(--fg-secondary)]">
              {kind === "ClusterRoleBinding" ? "ClusterRoleBinding · cluster-scoped" : `RoleBinding · namespace ${namespace}`}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                placeholder="name"
                aria-label="Binding name"
                className="min-w-[160px] flex-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[11px] py-[9px] font-[var(--font-mono)] text-[12.5px] text-[var(--fg-primary)] outline-none"
              />
              <div className="flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
                {(["RoleBinding", "ClusterRoleBinding"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => selectKind(k)}
                    className={`px-3 py-[9px] text-[12px] ${kind === k ? "bg-white/[0.08] text-[var(--fg-primary)]" : "text-[var(--fg-tertiary)]"}`}
                  >
                    {k}
                  </button>
                ))}
              </div>
              {kind === "RoleBinding" && (
                <NamespaceField value={namespace} onChange={setNamespace} className="w-[160px]" />
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
              GRANTS ROLE
            </span>
            <div className="flex items-center gap-2">
              <select
                aria-label="Role ref kind"
                value={roleRef.kind ?? "Role"}
                disabled={kind === "ClusterRoleBinding"}
                onChange={(e) => setRoleRef({ ...roleRef, kind: e.target.value, name: "" })}
                className={selectClass("w-[160px]") + (kind === "ClusterRoleBinding" ? " opacity-60" : "")}
              >
                <option value="Role">Role</option>
                <option value="ClusterRole">ClusterRole</option>
              </select>
              {roleNameOptions.length > 0 ? (
                <select
                  aria-label="Role ref name"
                  value={roleRef.name ?? ""}
                  onChange={(e) => setRoleRef({ ...roleRef, name: e.target.value })}
                  className={selectClass("flex-1")}
                >
                  <option value="" disabled>
                    Select role…
                  </option>
                  {roleNameOptions.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label="Role ref name"
                  value={roleRef.name ?? ""}
                  onChange={(e) => setRoleRef({ ...roleRef, name: e.target.value })}
                  placeholder="role name"
                  className="flex-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[11px] py-[9px] font-[var(--font-mono)] text-[12.5px] text-[var(--fg-primary)] outline-none"
                />
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
              SUBJECTS
            </span>
            <span className="font-[var(--font-mono)] text-[11px] text-[var(--fg-tertiary)]">{subjects.length}</span>
            <div className="h-px flex-1 bg-[var(--border-subtle)]" />
          </div>

          {subjects.map((s, i) => {
            const isSa = (s.kind ?? "ServiceAccount") === "ServiceAccount";
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Subject kind"
                  value={s.kind ?? "ServiceAccount"}
                  onChange={(e) => setSubject(i, { kind: e.target.value })}
                  className={selectClass("w-[150px]")}
                >
                  {SUBJECT_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
                <input
                  aria-label="Subject name"
                  value={s.name ?? ""}
                  onChange={(e) => setSubject(i, { name: e.target.value })}
                  placeholder="name"
                  className="min-w-[120px] flex-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[11px] py-[9px] font-[var(--font-mono)] text-[12.5px] text-[var(--fg-primary)] outline-none"
                />
                <NamespaceField
                  value={s.namespace ?? "default"}
                  onChange={(ns) => setSubject(i, { namespace: ns })}
                  disabled={!isSa}
                  ariaLabel="Subject namespace"
                  className="w-[130px]"
                />
                <button
                  type="button"
                  aria-label={`Remove subject ${s.name ?? ""}`}
                  onClick={() => setSubjects((ss) => ss.filter((_, j) => j !== i))}
                  className="flex size-[30px] items-center justify-center rounded-[var(--radius-md)] border border-[var(--border-subtle)] text-[var(--fg-tertiary)] hover:bg-white/[0.05]"
                >
                  <X className="size-[13px]" />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => setSubjects((ss) => [...ss, { kind: "ServiceAccount", name: "", namespace: "default" }])}
            className="flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] py-[10px] text-[12px] font-medium text-[var(--fg-secondary)] hover:bg-white/[0.04]"
          >
            <Plus className="size-[13px]" /> Add subject
          </button>
        </DialogBody>
        <DialogFooter showCloseButton={false}>
          {isEdit && onEditYaml && (
            <Button variant="outline" onClick={onEditYaml} className="mr-auto">
              <Code className="size-[13px]" /> Edit YAML
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid} onClick={apply}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
