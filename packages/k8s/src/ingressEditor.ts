// Pure EDIT logic for Ingresses: extract the editable fields from a live object,
// validate, and emit a clean `kubectl apply -f -` manifest. Like the ConfigMap /
// Secret editors, the YAML emitter is hand-rolled (no YAML dependency in the
// bundle) and all the testable logic lives here so the React editor stays thin.
//
// Server-managed metadata (uid/resourceVersion/creationTimestamp/managedFields/
// status) is dropped, and the kubectl last-applied-configuration annotation is
// stripped from the editable set. Labels are carried through unchanged; the form
// edits class, rules, TLS, and annotations.

/** The subset of a live Ingress this module reads (structurally a k8s Ingress). */
export interface IngressLike {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string> | null;
    annotations?: Record<string, string> | null;
  };
  spec?: {
    ingressClassName?: string;
    rules?: {
      host?: string;
      http?: { paths?: { path?: string; pathType?: string; backend?: { service?: { name?: string; port?: { number?: number; name?: string } } } }[] };
    }[];
    tls?: { hosts?: string[]; secretName?: string }[];
  };
}

export interface IngressPathInput {
  path: string;
  pathType: string;
  serviceName: string;
  /** Numeric ("80") or named ("http") service port. */
  servicePort: string;
}
export interface IngressRuleInput {
  host: string;
  paths: IngressPathInput[];
}
export interface IngressTLSInput {
  /** Comma/space-separated hosts; normalized on build. */
  hosts: string;
  secretName: string;
}

/** The normalized editable shape the React editor binds to + the builder consumes. */
export interface IngressInput {
  name: string;
  namespace: string;
  ingressClassName: string;
  /** Editable annotations (last-applied-configuration already stripped). */
  annotations: Record<string, string>;
  /** Carried through unchanged (not edited by the form). */
  labels: Record<string, string>;
  rules: IngressRuleInput[];
  tls: IngressTLSInput[];
}

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";
export const IMPLEMENTATION_SPECIFIC = "ImplementationSpecific";

export function blankPath(): IngressPathInput {
  return { path: "/", pathType: "Prefix", serviceName: "", servicePort: "" };
}
export function blankRule(): IngressRuleInput {
  return { host: "", paths: [blankPath()] };
}
export function blankTLS(): IngressTLSInput {
  return { hosts: "", secretName: "" };
}

/** Extract the editable fields from a live Ingress into the editor's input shape. */
export function ingressToInput(ing: IngressLike): IngressInput {
  const annotations: Record<string, string> = {};
  for (const [k, v] of Object.entries(ing.metadata.annotations ?? {})) {
    if (k === LAST_APPLIED) continue; // server noise — re-created by apply
    annotations[k] = v;
  }
  const rules: IngressRuleInput[] = (ing.spec?.rules ?? []).map((r) => ({
    host: r.host ?? "",
    paths: (r.http?.paths ?? []).map((p) => {
      const port = p.backend?.service?.port;
      return {
        path: p.path ?? "",
        pathType: p.pathType ?? "Prefix",
        serviceName: p.backend?.service?.name ?? "",
        servicePort: port?.number != null ? String(port.number) : (port?.name ?? ""),
      };
    }),
  }));
  const tls: IngressTLSInput[] = (ing.spec?.tls ?? []).map((t) => ({
    hosts: (t.hosts ?? []).join(", "),
    secretName: t.secretName ?? "",
  }));
  return {
    name: ing.metadata.name,
    namespace: ing.metadata.namespace ?? "default",
    ingressClassName: ing.spec?.ingressClassName ?? "",
    annotations,
    labels: { ...(ing.metadata.labels ?? {}) },
    rules,
    tls,
  };
}

/** Split a comma/space-separated host list into trimmed, non-empty entries. */
function splitHosts(hosts: string): string[] {
  return hosts.split(/[,\s]+/).map((h) => h.trim()).filter(Boolean);
}

/**
 * Submittable when the name is non-empty and every routing path is fully
 * specified (a path needs a service name + port). At least one complete path is
 * required so we never emit a rules-only-but-empty Ingress.
 */
export function canSubmitIngress(input: IngressInput): boolean {
  if (input.name.trim() === "") return false;
  let complete = 0;
  for (const rule of input.rules) {
    for (const p of rule.paths) {
      const hasSvc = p.serviceName.trim() !== "";
      const hasPort = p.servicePort.trim() !== "";
      if (hasSvc !== hasPort) return false; // half-filled path
      if (hasSvc && hasPort) complete++;
    }
  }
  return complete > 0;
}

// ---------------------------------------------------------------------------
// YAML emitter (hand-rolled — no YAML dependency)
// ---------------------------------------------------------------------------

/** A plain, unquoted-safe YAML scalar token (DNS names, paths-without-specials, ids). */
const PLAIN = /^[A-Za-z0-9]([A-Za-z0-9._/-]*[A-Za-z0-9])?$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

/** Emit a YAML scalar, quoting (with escaping) when a bare token would be unsafe. */
function scalar(value: string): string {
  if (value !== "" && PLAIN.test(value) && !RESERVED.has(value.toLowerCase()) && !/^-?\d+(\.\d+)?$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Numeric port → bare number; named port → quoted/plain scalar. */
function portLine(indent: string, servicePort: string): string[] {
  const trimmed = servicePort.trim();
  if (/^\d+$/.test(trimmed)) return [`${indent}port:`, `${indent}  number: ${trimmed}`];
  return [`${indent}port:`, `${indent}  name: ${scalar(trimmed)}`];
}

function mapLines(indent: string, entries: Record<string, string>): string[] {
  return Object.entries(entries).map(([k, v]) => `${indent}${scalar(k)}: ${scalar(v)}`);
}

/**
 * Build a complete Ingress manifest (networking.k8s.io/v1) for `kubectl apply
 * -f -`. Omits empty sections (no class / tls / labels / annotations → those keys
 * are dropped). Paths missing a service are skipped; rules left with no paths and
 * no host are dropped.
 */
export function buildIngressYAML(input: IngressInput): string {
  const out: string[] = [
    "apiVersion: networking.k8s.io/v1",
    "kind: Ingress",
    "metadata:",
    `  name: ${scalar(input.name.trim())}`,
    `  namespace: ${scalar(input.namespace.trim() || "default")}`,
  ];

  if (Object.keys(input.labels).length > 0) {
    out.push("  labels:", ...mapLines("    ", input.labels));
  }
  if (Object.keys(input.annotations).length > 0) {
    out.push("  annotations:", ...mapLines("    ", input.annotations));
  }

  out.push("spec:");
  if (input.ingressClassName.trim() !== "") {
    out.push(`  ingressClassName: ${scalar(input.ingressClassName.trim())}`);
  }

  const tls = input.tls
    .map((t) => ({ hosts: splitHosts(t.hosts), secretName: t.secretName.trim() }))
    .filter((t) => t.hosts.length > 0 || t.secretName !== "");
  if (tls.length > 0) {
    out.push("  tls:");
    for (const t of tls) {
      out.push("    - hosts:");
      if (t.hosts.length === 0) {
        // Edge: a secret with no hosts — emit an empty list to stay valid YAML.
        out[out.length - 1] = "    - hosts: []";
      } else {
        for (const h of t.hosts) out.push(`        - ${scalar(h)}`);
      }
      if (t.secretName !== "") out.push(`      secretName: ${scalar(t.secretName)}`);
    }
  }

  // Only rules with a host or at least one complete path are emitted.
  const rules = input.rules
    .map((r) => ({
      host: r.host.trim(),
      paths: r.paths.filter((p) => p.serviceName.trim() !== "" && p.servicePort.trim() !== ""),
    }))
    .filter((r) => r.host !== "" || r.paths.length > 0);
  if (rules.length > 0) {
    out.push("  rules:");
    for (const r of rules) {
      out.push(r.host !== "" ? `    - host: ${scalar(r.host)}` : "    -");
      out.push("      http:");
      out.push("        paths:");
      for (const p of r.paths) {
        out.push(`          - path: ${scalar(p.path.trim() || "/")}`);
        out.push(`            pathType: ${scalar(p.pathType.trim() || "Prefix")}`);
        out.push("            backend:");
        out.push("              service:");
        out.push(`                name: ${scalar(p.serviceName.trim())}`);
        out.push(...portLine("                ", p.servicePort));
      }
    }
  }

  return out.join("\n") + "\n";
}
