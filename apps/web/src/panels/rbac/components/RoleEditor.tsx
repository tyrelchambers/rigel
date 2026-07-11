import { useMemo, useState } from "react";
import { ShieldCheck, Plus, Trash2, Code } from "lucide-react";
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
import type { PolicyRule } from "../types";
import { ruleRisk } from "../risk";
import { buildRoleYaml } from "../manifest";
import { NamespaceField } from "@/components/NamespaceField";
import { TokenInput } from "./TokenInput";
import { Segmented } from "./Segmented";
import { SectionHeader } from "./SectionHeader";
import { LabeledField, fieldInputClass, fieldSurface } from "./LabeledField";
import { useApiResources } from "@/lib/api";

const RBAC_VERBS = ["get", "list", "watch", "create", "update", "patch", "delete", "deletecollection", "bind", "escalate", "impersonate", "use", "*"];

export function verbSuggestionsForResources(
  resources: string[],
  verbsByResource: Record<string, string[]>,
): string[] {
  const known = resources
    .map((r) => verbsByResource[r])
    .filter((v): v is string[] => Array.isArray(v) && v.length > 0);
  if (known.length === 0) return RBAC_VERBS;
  const union = new Set<string>();
  for (const vs of known) for (const v of vs) union.add(v);
  union.add("*");
  return [...union].sort();
}

export const ROLE_PRESETS: { id: string; label: string; rules: PolicyRule[] }[] = [
  { id: "read-only", label: "Read-only", rules: [
    { apiGroups: ["*"], resources: ["*"], verbs: ["get", "list", "watch"] },
  ] },
  { id: "namespace-admin", label: "Namespace admin", rules: [
    { apiGroups: ["*"], resources: ["*"], verbs: ["*"] },
  ] },
  { id: "deployer", label: "Deployer", rules: [
    { apiGroups: ["apps"], resources: ["deployments", "replicasets", "statefulsets", "daemonsets"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
    { apiGroups: [""], resources: ["pods", "services", "configmaps", "secrets"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
  ] },
];

function cloneRules(rules: PolicyRule[]): PolicyRule[] {
  return rules.map((r) => ({
    apiGroups: [...(r.apiGroups ?? [])],
    resources: [...(r.resources ?? [])],
    verbs: [...(r.verbs ?? [])],
  }));
}

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
  const { data: apiResources } = useApiResources();
  const groupSuggestions = useMemo(
    () => Array.from(new Set([...(apiResources?.groups ?? []), "*"])),
    [apiResources],
  );
  const resourceSuggestions = useMemo(
    () => Array.from(new Set([...(apiResources?.resources ?? []), "*"])),
    [apiResources],
  );
  const verbsByResource = apiResources?.verbsByResource ?? {};
  const [preset, setPreset] = useState<string | null>(null);

  function setRule(i: number, patch: Partial<PolicyRule>) {
    setPreset(null);
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
      <DialogContent className="max-h-[86vh] w-[calc(100%-2rem)] max-w-[720px]">
        <DialogHeader className="border-[#26272B]">
          <DialogIcon background={false} className="size-9 rounded-[9px]" style={{ background: "#38BDF826" }}>
            <ShieldCheck className="size-[18px]" style={{ color: "#38BDF8" }} />
          </DialogIcon>
          <div className="flex min-w-0 flex-col gap-[3px]">
            <DialogTitle className="text-[20px] font-bold text-white">
              {isEdit ? `Edit role · ${target!.name}` : "New role"}
            </DialogTitle>
            <DialogDescription className="text-[13px]" style={{ color: "#6B6B73" }}>
              {isEdit
                ? kind === "ClusterRole"
                  ? "ClusterRole · cluster-scoped"
                  : `Role · namespace ${namespace}`
                : "Define what this role can do."}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-[18px] p-6">
          {!isEdit && (
            <>
              <LabeledField label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. pod-reader"
                  aria-label="Role name"
                  className={fieldInputClass}
                  style={fieldSurface}
                />
              </LabeledField>
              <div className="flex items-center gap-[14px]">
                <Segmented
                  options={["Role", "ClusterRole"] as const}
                  value={kind}
                  onChange={setKind}
                  ariaLabel="Role kind"
                />
                {kind === "Role" && (
                  <NamespaceField value={namespace} onChange={setNamespace} className="flex-1" />
                )}
              </div>
            </>
          )}

          {!isEdit && (
            <div className="flex flex-col gap-[8px]">
              <span
                className="font-[var(--font-mono)] text-[10.5px] uppercase tracking-[0.8px]"
                style={{ color: "#6B6B73" }}
              >
                Preset
              </span>
              <div className="flex flex-wrap gap-[7px]">
                {ROLE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setPreset(p.id);
                      setRules(cloneRules(p.rules));
                    }}
                    className="rounded-[6px] border px-[12px] py-[6px] text-[13px] font-semibold"
                    style={
                      preset === p.id
                        ? { borderColor: "#38BDF8", color: "#38BDF8", background: "#38BDF814" }
                        : { borderColor: "#26272B", color: "#A1A1AA", background: "#FFFFFF05" }
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <SectionHeader label="RULES" count={rules.length} />

          {rules.map((r, i) => {
            const dangerous = ruleRisk(r) === "dangerous";
            return (
              <div
                key={i}
                className="flex flex-col gap-[14px] rounded-[8px] border p-4"
                style={{ background: "#0C0D0F", borderColor: dangerous ? "color-mix(in srgb, var(--status-failed) 25%, transparent)" : "#26272B" }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-semibold text-white">Rule {i + 1}</span>
                  <button
                    type="button"
                    aria-label="Remove rule"
                    onClick={() => {
                      setPreset(null);
                      setRules((rs) => rs.filter((_, j) => j !== i));
                    }}
                    className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] hover:bg-white/[0.05]"
                    style={{ color: "#6B6B73" }}
                  >
                    <Trash2 className="size-[14px]" />
                  </button>
                </div>
                <TokenInput
                  label="API GROUPS"
                  tokens={(r.apiGroups ?? []).map((g) => (g === "" ? "core" : g))}
                  onChange={(t) => setRule(i, { apiGroups: t.map((g) => (g === "core" ? "" : g)) })}
                  placeholder="core"
                  suggestions={groupSuggestions}
                />
                <TokenInput
                  label="RESOURCES"
                  tokens={r.resources ?? []}
                  onChange={(t) => setRule(i, { resources: t })}
                  danger={(t) => t === "secrets" || t === "*"}
                  suggestions={resourceSuggestions}
                />
                <TokenInput
                  label="VERBS"
                  tokens={r.verbs ?? []}
                  onChange={(t) => setRule(i, { verbs: t })}
                  danger={(t) => ["*", "escalate", "bind", "impersonate"].includes(t)}
                  suggestions={verbSuggestionsForResources(r.resources ?? [], verbsByResource)}
                />
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => {
              setPreset(null);
              setRules((rs) => [...rs, blankRule()]);
            }}
            className="flex w-full items-center justify-center gap-[7px] rounded-[6px] border px-[14px] py-[12px] text-[13px] font-semibold"
            style={{ background: "#FFFFFF05", borderColor: "#26272B", color: "#A1A1AA" }}
          >
            <Plus className="size-[15px]" /> Add rule
          </button>
        </DialogBody>
        <DialogFooter>
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
