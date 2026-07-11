import { useEffect, useMemo, useState } from "react";
import { Link2, Plus, Trash2, Code, ChevronDown, User } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { RoleRef, Subject } from "../types";
import { buildBindingYaml } from "../manifest";
import { NamespaceField } from "@/components/NamespaceField";
import { Segmented } from "./Segmented";
import { SectionHeader } from "./SectionHeader";
import { LabeledField, fieldInputClass, fieldSurface } from "./LabeledField";

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
      <DialogContent className="max-h-[86vh] w-[calc(100%-2rem)] max-w-[720px]">
        <DialogHeader className="border-[#26272B]">
          <DialogIcon background={false} className="size-9 rounded-[9px]" style={{ background: "#38BDF826" }}>
            <Link2 className="size-[18px]" style={{ color: "#38BDF8" }} />
          </DialogIcon>
          <div className="flex min-w-0 flex-col gap-[3px]">
            <DialogTitle className="text-[20px] font-bold text-white">
              {isEdit ? `Edit binding · ${target!.name}` : "New binding"}
            </DialogTitle>
            <DialogDescription className="text-[13px]" style={{ color: "#6B6B73" }}>
              {isEdit
                ? kind === "ClusterRoleBinding"
                  ? "ClusterRoleBinding · cluster-scoped"
                  : `RoleBinding · namespace ${namespace}`
                : "Grant a role to users, groups, or service accounts."}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-[18px] p-6">
          {!isEdit && (
            <>
              <div className="flex items-end gap-[14px]">
                <LabeledField label="Name" className="flex-1">
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameTouched(true);
                    }}
                    placeholder="e.g. read-pods"
                    aria-label="Binding name"
                    className={fieldInputClass}
                    style={fieldSurface}
                  />
                </LabeledField>
                <Segmented
                  options={["RoleBinding", "ClusterRoleBinding"] as const}
                  value={kind}
                  onChange={selectKind}
                  ariaLabel="Binding kind"
                />
              </div>
              {kind === "RoleBinding" && (
                <NamespaceField value={namespace} onChange={setNamespace} className="w-full" />
              )}
            </>
          )}

          <SectionHeader label="GRANTS ROLE" />
          <div className="flex items-center gap-[14px]">
            <Segmented
              options={["Role", "ClusterRole"] as const}
              value={(roleRef.kind as "Role" | "ClusterRole") ?? "Role"}
              onChange={(k) => setRoleRef({ ...roleRef, kind: k, name: "" })}
              disabled={kind === "ClusterRoleBinding"}
              ariaLabel="Role ref kind"
            />
            {roleNameOptions.length > 0 ? (
              <div className="relative flex-1">
                <select
                  aria-label="Role ref name"
                  value={roleRef.name ?? ""}
                  onChange={(e) => setRoleRef({ ...roleRef, name: e.target.value })}
                  className={`${fieldInputClass} appearance-none pr-9`}
                  style={fieldSurface}
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
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-[14px] -translate-y-1/2" style={{ color: "#6B6B73" }} />
              </div>
            ) : (
              <input
                aria-label="Role ref name"
                value={roleRef.name ?? ""}
                onChange={(e) => setRoleRef({ ...roleRef, name: e.target.value })}
                placeholder="role name"
                className={`${fieldInputClass} flex-1`}
                style={fieldSurface}
              />
            )}
          </div>

          <SectionHeader label="SUBJECTS" count={subjects.length} />

          {subjects.map((s, i) => {
            const isSa = (s.kind ?? "ServiceAccount") === "ServiceAccount";
            return (
              <div key={i} className="flex flex-wrap items-center gap-[10px]">
                <div className="relative w-[170px]">
                  <User className="pointer-events-none absolute left-3 top-1/2 size-[14px] -translate-y-1/2" style={{ color: "#6B6B73" }} />
                  <select
                    aria-label="Subject kind"
                    value={s.kind ?? "ServiceAccount"}
                    onChange={(e) => setSubject(i, { kind: e.target.value })}
                    className={`${fieldInputClass} appearance-none pl-[34px] pr-9`}
                    style={fieldSurface}
                  >
                    {SUBJECT_KINDS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-[14px] -translate-y-1/2" style={{ color: "#6B6B73" }} />
                </div>
                <input
                  aria-label="Subject name"
                  value={s.name ?? ""}
                  onChange={(e) => setSubject(i, { name: e.target.value })}
                  placeholder="name"
                  className={`${fieldInputClass} min-w-[120px] flex-1`}
                  style={fieldSurface}
                />
                <NamespaceField
                  value={s.namespace ?? "default"}
                  onChange={(ns) => setSubject(i, { namespace: ns })}
                  disabled={!isSa}
                  ariaLabel="Subject namespace"
                  className="w-[150px]"
                />
                <button
                  type="button"
                  aria-label={`Remove subject ${s.name ?? ""}`}
                  onClick={() => setSubjects((ss) => ss.filter((_, j) => j !== i))}
                  className="flex size-9 items-center justify-center rounded-[6px] border hover:bg-white/[0.05]"
                  style={{ borderColor: "#26272B", color: "#6B6B73" }}
                >
                  <Trash2 className="size-[14px]" />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => setSubjects((ss) => [...ss, { kind: "ServiceAccount", name: "", namespace: "default" }])}
            className="flex w-full items-center justify-center gap-[7px] rounded-[6px] border px-[14px] py-[12px] text-[13px] font-semibold"
            style={{ background: "#FFFFFF05", borderColor: "#26272B", color: "#A1A1AA" }}
          >
            <Plus className="size-[15px]" /> Add subject
          </button>
        </DialogBody>
        <DialogFooter showCloseButton={false} className="border-[#26272B]">
          {isEdit && onEditYaml && (
            <Button variant="outline" onClick={onEditYaml} className="mr-auto">
              <Code className="size-[13px]" /> Edit YAML
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid} onClick={apply} className="h-auto px-6 py-[11px]">Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
