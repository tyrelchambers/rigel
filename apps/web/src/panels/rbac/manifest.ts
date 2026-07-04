import { yamlSingleQuoted } from "@rigel/k8s";
import type { PolicyRule } from "./types";

export interface RbacMeta {
  kind: "Role" | "ClusterRole" | "RoleBinding" | "ClusterRoleBinding";
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

const q = yamlSingleQuoted;

/** Inline YAML flow sequence with single-quoted items; `[]` when empty. */
function flowSeq(items: string[] | undefined): string {
  if (!items || items.length === 0) return "[]";
  return `[${items.map((i) => q(i)).join(", ")}]`;
}

function metaBlock(meta: RbacMeta): string[] {
  const lines = ["metadata:", `  name: ${q(meta.name)}`];
  if (meta.namespace && meta.namespace.trim() !== "") {
    lines.push(`  namespace: ${q(meta.namespace)}`);
  }
  const mapBlock = (key: string, m?: Record<string, string>) => {
    if (!m || Object.keys(m).length === 0) return;
    lines.push(`  ${key}:`);
    for (const k of Object.keys(m).sort()) lines.push(`    ${q(k)}: ${q(m[k]!)}`);
  };
  mapBlock("labels", meta.labels);
  mapBlock("annotations", meta.annotations);
  return lines;
}

/** Build a Role/ClusterRole manifest. Empty apiGroups defaults to the core group. */
export function buildRoleYaml(meta: RbacMeta, rules: PolicyRule[]): string {
  const lines = ["apiVersion: rbac.authorization.k8s.io/v1", `kind: ${meta.kind}`, ...metaBlock(meta)];
  if (rules.length === 0) {
    lines.push("rules: []");
  } else {
    lines.push("rules:");
    for (const r of rules) {
      const groups = r.apiGroups && r.apiGroups.length > 0 ? r.apiGroups : [""];
      lines.push(`  - apiGroups: ${flowSeq(groups)}`);
      lines.push(`    resources: ${flowSeq(r.resources)}`);
      lines.push(`    verbs: ${flowSeq(r.verbs)}`);
    }
  }
  return lines.join("\n") + "\n";
}
