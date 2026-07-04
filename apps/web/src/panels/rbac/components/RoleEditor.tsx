import { useState } from "react";
import { FileBadge, Plus, Trash2, Code } from "lucide-react";
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
import type { PolicyRule } from "../types";
import { ruleRisk } from "../risk";
import { buildRoleYaml } from "../manifest";
import { NamespaceField } from "./NamespaceField";
import { TokenInput } from "./TokenInput";

export interface RoleTarget {
  kind: "Role" | "ClusterRole";
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  rules: PolicyRule[];
}

interface Props {
  /** null = create mode. */
  target: RoleTarget | null;
  open: boolean;
  onClose: () => void;
  onApply: (result: { yaml: string; label: string }) => void;
  onEditYaml?: () => void;
}

function blankRule(): PolicyRule {
  return { apiGroups: [], resources: [], verbs: [] };
}

export function RoleEditor({ target, open, onClose, onApply, onEditYaml }: Props) {
  const isEdit = target != null && target.name.trim() !== "";
  const [kind, setKind] = useState<"Role" | "ClusterRole">(target?.kind ?? "Role");
  const [name, setName] = useState(target?.name ?? "");
  const [namespace, setNamespace] = useState(target?.namespace ?? "default");
  const [rules, setRules] = useState<PolicyRule[]>(
    target?.rules?.length ? target.rules.map((r) => ({ ...r })) : [blankRule()],
  );

  function setRule(i: number, patch: Partial<PolicyRule>) {
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const valid = name.trim() !== "";

  function apply() {
    const yaml = buildRoleYaml(
      {
        kind,
        name: name.trim(),
        namespace: kind === "Role" ? namespace.trim() : undefined,
        labels: target?.labels,
        annotations: target?.annotations,
      },
      rules,
    );
    onApply({ yaml, label: `Apply ${kind} ${name.trim()}` });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[86vh] w-[calc(100%-2rem)] max-w-[560px]">
        <DialogHeader>
          <DialogIcon>
            <FileBadge className="size-[15px] text-[var(--accent-primary)]" />
          </DialogIcon>
          <DialogTitle>{isEdit ? `Edit role · ${target!.name}` : "New role"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {isEdit ? (
            <p className="text-[12px] text-[var(--fg-secondary)]">
              {kind === "ClusterRole" ? "ClusterRole · cluster-scoped" : `Role · namespace ${namespace}`}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="name"
                aria-label="Role name"
                className="min-w-[160px] flex-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[11px] py-[9px] font-[var(--font-mono)] text-[12.5px] text-[var(--fg-primary)] outline-none"
              />
              <div className="flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
                {(["Role", "ClusterRole"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`px-3 py-[9px] text-[12px] ${kind === k ? "bg-white/[0.08] text-[var(--fg-primary)]" : "text-[var(--fg-tertiary)]"}`}
                  >
                    {k}
                  </button>
                ))}
              </div>
              {kind === "Role" && (
                <NamespaceField value={namespace} onChange={setNamespace} className="w-[160px]" />
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
              RULES
            </span>
            <span className="font-[var(--font-mono)] text-[11px] text-[var(--fg-tertiary)]">{rules.length}</span>
            <div className="h-px flex-1 bg-[var(--border-subtle)]" />
          </div>

          {rules.map((r, i) => {
            const dangerous = ruleRisk(r) === "dangerous";
            return (
              <div
                key={i}
                className={`flex flex-col gap-[10px] rounded-[var(--radius-md)] border bg-[var(--surface-sunken)] p-[13px] ${
                  dangerous ? "border-[var(--status-failed)]/25" : "border-[var(--border-subtle)]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-[var(--font-mono)] text-[11px] font-semibold text-[var(--fg-secondary)]">
                    Rule {i + 1}
                  </span>
                  <button
                    type="button"
                    aria-label="Remove rule"
                    onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                    className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-tertiary)] hover:bg-white/[0.05]"
                  >
                    <Trash2 className="size-[13px]" />
                  </button>
                </div>
                <TokenInput
                  label="API GROUPS"
                  tokens={(r.apiGroups ?? []).map((g) => (g === "" ? "core" : g))}
                  onChange={(t) => setRule(i, { apiGroups: t.map((g) => (g === "core" ? "" : g)) })}
                  placeholder="core"
                />
                <TokenInput label="RESOURCES" tokens={r.resources ?? []} onChange={(t) => setRule(i, { resources: t })} danger={(t) => t === "secrets" || t === "*"} />
                <TokenInput label="VERBS" tokens={r.verbs ?? []} onChange={(t) => setRule(i, { verbs: t })} danger={(t) => ["*", "escalate", "bind", "impersonate"].includes(t)} />
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => setRules((rs) => [...rs, blankRule()])}
            className="flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] py-[10px] text-[12px] font-medium text-[var(--fg-secondary)] hover:bg-white/[0.04]"
          >
            <Plus className="size-[13px]" /> Add rule
          </button>
        </DialogBody>
        <DialogFooter showCloseButton={false}>
          {isEdit && onEditYaml && (
            <Button variant="outline" onClick={onEditYaml} className="mr-auto">
              <Code className="size-[13px]" /> Edit YAML
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} onClick={apply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
