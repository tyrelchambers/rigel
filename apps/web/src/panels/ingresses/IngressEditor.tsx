import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Ingress } from "./types";
import type { KVRow } from "@rigel/k8s";
import {
  blankRow,
  newRowId,
  rowsToConfigMapData,
  ingressToInput,
  canSubmitIngress,
  buildIngressYAML,
  blankRule,
  blankPath,
  blankTLS,
  type IngressRuleInput,
  type IngressTLSInput,
} from "@rigel/k8s";
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
import { TabBar, Tab } from "@/components/ui/Tabs";
import { KeyValueEditor } from "../components/KeyValueEditor";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { Box, Globe, Lock, Network, Plus, Server, Trash2, X } from "lucide-react";

// ---------------------------------------------------------------------------
// IngressEditor — edit an Ingress's values (class, rules, TLS, annotations) via
// a guided form, with a Form ⇄ YAML toggle. The form is the source of truth; the
// YAML view is rebuilt from the fields each time you enter it and can be edited
// raw before applying. Name + namespace are read-only; labels are carried through
// unchanged. Builds the manifest with `buildIngressYAML` and applies it through
// POST /api/apply (`kubectl apply -f -`). The watch auto-refreshes the panel.
// ---------------------------------------------------------------------------

interface ApplyResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Full-width field box (Name / Namespace / Ingress class).
const boxInput =
  "w-full rounded-md border px-3.5 py-[11px] text-sm font-mono outline-none transition-colors border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-[var(--fg-primary)] placeholder:text-[var(--fg-tertiary)] focus:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:text-[var(--fg-secondary)]";
// Compact cell used inside path / TLS rows.
const cellInput =
  "rounded border px-2.5 py-2 text-xs font-mono outline-none transition-colors border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-[var(--fg-primary)] placeholder:text-[var(--fg-tertiary)] focus:border-[var(--accent-primary)]";

const PATH_TYPES = ["Prefix", "Exact", "ImplementationSpecific"];

export interface IngressEditorProps {
  target: Ingress | null;
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
}

function recordToRows(rec: Record<string, string>): KVRow[] {
  const rows = Object.entries(rec).map(([key, value]) => ({ id: newRowId(), key, value }));
  return rows.length > 0 ? rows : [blankRow()];
}

export function IngressEditor({ target, open, onClose, onApplied }: IngressEditorProps) {
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [ingressClassName, setIngressClassName] = useState("");
  const [rules, setRules] = useState<IngressRuleInput[]>([blankRule()]);
  const [tls, setTls] = useState<IngressTLSInput[]>([]);
  const [annotationRows, setAnnotationRows] = useState<KVRow[]>([blankRow()]);

  const [mode, setMode] = useState<"form" | "yaml">("form");
  const [yamlText, setYamlText] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const { data: schema } = useClusterYamlSchema();

  // (Re)seed the form each time the sheet opens on a target.
  useEffect(() => {
    if (!open || !target) return;
    const seeded = ingressToInput(target);
    setName(seeded.name);
    setNamespace(seeded.namespace);
    setLabels(seeded.labels);
    setIngressClassName(seeded.ingressClassName);
    setRules(seeded.rules.length > 0 ? seeded.rules : [blankRule()]);
    setTls(seeded.tls);
    setAnnotationRows(recordToRows(seeded.annotations));
    setMode("form");
    setYamlText("");
    setBusy(false);
    setServerError(null);
  }, [open, target]);

  const formInput = useMemo(
    () => ({
      name,
      namespace,
      ingressClassName,
      labels,
      annotations: rowsToConfigMapData(annotationRows),
      rules,
      tls,
    }),
    [name, namespace, ingressClassName, labels, annotationRows, rules, tls],
  );

  const builtYaml = useMemo(() => buildIngressYAML(formInput), [formInput]);
  const formValid = canSubmitIngress(formInput);
  const valid = mode === "yaml" ? yamlText.trim() !== "" : formValid;
  const yamlToApply = mode === "yaml" ? yamlText : builtYaml;

  function enterYaml() {
    setYamlText(builtYaml); // rebuild from the fields whenever we enter YAML mode
    setMode("yaml");
  }

  // --- rule / path / tls mutators ------------------------------------------
  const updateRule = (i: number, patch: Partial<IngressRuleInput>) =>
    setRules((rs) => rs.map((r, ri) => (ri === i ? { ...r, ...patch } : r)));
  const addRule = () => setRules((rs) => [...rs, blankRule()]);
  const removeRule = (i: number) => setRules((rs) => rs.filter((_, ri) => ri !== i));
  const updatePath = (ri: number, pi: number, patch: Partial<IngressRuleInput["paths"][number]>) =>
    setRules((rs) => rs.map((r, i) => (i === ri ? { ...r, paths: r.paths.map((p, j) => (j === pi ? { ...p, ...patch } : p)) } : r)));
  const addPath = (ri: number) =>
    setRules((rs) => rs.map((r, i) => (i === ri ? { ...r, paths: [...r.paths, blankPath()] } : r)));
  const removePath = (ri: number, pi: number) =>
    setRules((rs) => rs.map((r, i) => (i === ri ? { ...r, paths: r.paths.filter((_, j) => j !== pi) } : r)));
  const updateTls = (i: number, patch: Partial<IngressTLSInput>) =>
    setTls((ts) => ts.map((t, ti) => (ti === i ? { ...t, ...patch } : t)));
  const addTls = () => setTls((ts) => [...ts, blankTLS()]);
  const removeTls = (i: number) => setTls((ts) => ts.filter((_, ti) => ti !== i));

  async function handleApply() {
    setServerError(null);
    if (!valid) return;
    setBusy(true);
    try {
      const res = await apiFetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: yamlToApply }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
        throw new Error(body.error ?? res.statusText);
      }
      const result = (await res.json()) as ApplyResult;
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || "kubectl apply failed");
      }
      onApplied?.();
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const ruleCount = `${rules.length} ${rules.length === 1 ? "rule" : "rules"}`;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[680px]">
        <DialogHeader>
          <DialogIcon className="rounded-[9px] bg-[var(--accent-dim)] text-[var(--accent-primary)]">
            <Network className="size-[18px]" aria-hidden />
          </DialogIcon>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <DialogTitle className="shrink-0 text-lg font-bold text-[var(--fg-primary)]">Edit Ingress</DialogTitle>
              {name && (
                <span className="flex min-w-0 items-center gap-1.5 rounded bg-[var(--accent-dim)] px-2 py-0.5">
                  <Globe className="size-3 shrink-0 text-[var(--accent-primary)]" aria-hidden />
                  <span className="truncate font-mono text-xs text-[var(--accent-primary)]">{name}</span>
                </span>
              )}
            </div>
            <span className="truncate text-xs text-[var(--fg-tertiary)]">
              Namespace {namespace} · class {ingressClassName || "none"} · {ruleCount}
            </span>
          </div>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-[18px]">
          <TabBar value={mode} onValueChange={(m) => (m === "yaml" ? enterYaml() : setMode("form"))} className="self-start">
            <Tab value="form">Form</Tab>
            <Tab value="yaml">YAML</Tab>
          </TabBar>

          {mode === "form" ? (
            <>
              {/* INGRESS */}
              <section className="flex flex-col gap-2.5">
                <SectionCap>Ingress</SectionCap>
                <div className="flex flex-col gap-3.5 sm:flex-row">
                  <Field label="Name">
                    <div className="relative">
                      <input value={name} disabled aria-label="name" className={cn(boxInput, "pr-9")} />
                      <Lock className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--fg-tertiary)]" aria-hidden />
                    </div>
                  </Field>
                  <Field label="Namespace">
                    <div className="relative">
                      <input value={namespace} disabled aria-label="namespace" className={cn(boxInput, "pl-9")} />
                      <Box className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--fg-tertiary)]" aria-hidden />
                    </div>
                  </Field>
                  <Field label="Ingress class">
                    <input
                      value={ingressClassName}
                      placeholder="nginx"
                      onChange={(e) => setIngressClassName(e.target.value)}
                      aria-label="ingress class"
                      className={boxInput}
                    />
                  </Field>
                </div>
              </section>

              <Divider />

              {/* RULES */}
              <section className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <SectionCap aside={ruleCount}>Rules</SectionCap>
                  <span className="text-xs text-[var(--fg-tertiary)]">Each rule routes a host and its HTTP paths to a backend service.</span>
                </div>

                {rules.map((rule, ri) => (
                  <div key={ri} className="flex flex-col gap-3 rounded-lg border p-3.5 border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
                    <div className="flex items-center gap-2.5">
                      <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md border px-3 py-2 border-[var(--border-subtle)] bg-[var(--surface-elevated)] focus-within:border-[var(--accent-primary)]">
                        <span className="shrink-0 rounded bg-white/[0.04] px-[7px] py-0.5 font-mono text-3xs uppercase tracking-[1px] text-[var(--fg-tertiary)]">Host</span>
                        <input
                          value={rule.host}
                          placeholder="all hosts"
                          onChange={(e) => updateRule(ri, { host: e.target.value })}
                          aria-label="host"
                          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)]"
                        />
                      </div>
                      {rules.length > 1 && (
                        <Button type="button" variant="destructive" size="sm" onClick={() => removeRule(ri)}>
                          <Trash2 aria-hidden /> Remove
                        </Button>
                      )}
                    </div>

                    <div className="flex flex-col gap-2 border-l-2 pl-3.5 border-[var(--accent-primary)]/25">
                      <SectionCap aside={`${rule.paths.length} ${rule.paths.length === 1 ? "path" : "paths"}`}>Paths</SectionCap>
                      {rule.paths.map((p, pi) => (
                        <div key={pi} className="flex flex-wrap items-center gap-2 rounded-md border p-2 border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
                          <input value={p.path} placeholder="/" onChange={(e) => updatePath(ri, pi, { path: e.target.value })} aria-label="path" className={cn(cellInput, "w-[92px]")} />
                          <select value={p.pathType} onChange={(e) => updatePath(ri, pi, { pathType: e.target.value })} aria-label="path type" className={cn(cellInput, "w-[132px]")}>
                            {PATH_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                          <span className="font-mono text-sm text-[var(--fg-tertiary)]">→</span>
                          <div className="flex min-w-[120px] flex-1 items-center gap-1.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] focus-within:border-[var(--accent-primary)]">
                            <Server className="ml-2.5 size-3.5 shrink-0 text-[var(--fg-tertiary)]" aria-hidden />
                            <input value={p.serviceName} placeholder="service" onChange={(e) => updatePath(ri, pi, { serviceName: e.target.value })} aria-label="service name" className="min-w-0 flex-1 bg-transparent py-2 pr-2.5 font-mono text-xs text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)]" />
                          </div>
                          <span className="font-mono text-sm text-[var(--fg-tertiary)]">:</span>
                          <input value={p.servicePort} placeholder="80" onChange={(e) => updatePath(ri, pi, { servicePort: e.target.value })} aria-label="service port" className={cn(cellInput, "w-[56px]")} />
                          {rule.paths.length > 1 && (
                            <Button type="button" variant="destructive" size="icon-sm" aria-label="Remove path" onClick={() => removePath(ri, pi)}>
                              <X aria-hidden />
                            </Button>
                          )}
                        </div>
                      ))}
                      <AddButton onClick={() => addPath(ri)}>Add path</AddButton>
                    </div>
                  </div>
                ))}

                <Button type="button" variant="subtle" onClick={addRule} className="w-full">
                  <Plus aria-hidden /> Add rule
                </Button>
              </section>

              <Divider />

              {/* TLS */}
              <section className="flex flex-col gap-2.5">
                <SectionCap>TLS</SectionCap>
                {tls.length === 0 && <p className="text-xs text-[var(--fg-tertiary)]">No TLS configured.</p>}
                {tls.map((t, ti) => (
                  <div key={ti} className="flex flex-wrap items-center gap-2 rounded-md border p-2 border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
                    <input value={t.hosts} placeholder="hosts (comma-separated)" onChange={(e) => updateTls(ti, { hosts: e.target.value })} aria-label="tls hosts" className={cn(cellInput, "min-w-[140px] flex-1")} />
                    <span className="font-mono text-sm text-[var(--fg-tertiary)]">→</span>
                    <input value={t.secretName} placeholder="tls-secret" onChange={(e) => updateTls(ti, { secretName: e.target.value })} aria-label="tls secret name" className={cn(cellInput, "w-[180px]")} />
                    <Button type="button" variant="destructive" size="icon-sm" aria-label="Remove TLS" onClick={() => removeTls(ti)}>
                      <X aria-hidden />
                    </Button>
                  </div>
                ))}
                <AddButton onClick={addTls}>Add TLS</AddButton>
              </section>

              <Divider />

              {/* ANNOTATIONS */}
              <section className="flex flex-col gap-2.5">
                <SectionCap>Annotations</SectionCap>
                <KeyValueEditor rows={annotationRows} onRowsChange={setAnnotationRows} keyPlaceholder="key (e.g. cert-manager.io/cluster-issuer)" />
              </section>

              {labels && Object.keys(labels).length > 0 && (
                <p className="font-mono text-xs text-[var(--fg-tertiary)]">{Object.keys(labels).length} label(s) preserved unchanged.</p>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-[var(--fg-tertiary)]">
                Edit the manifest directly. Switching back to <b>Form</b> rebuilds this from the fields (raw edits are discarded).
              </p>
              <div className="h-[52vh] w-full overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
                <YamlEditor value={yamlText} onChange={setYamlText} schema={schema ?? null} />
              </div>
            </div>
          )}

          {serverError && (
            <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
              {serverError}
            </pre>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={handleApply} disabled={busy || !valid}>{busy ? "Saving…" : "Save changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A section caption: uppercase mono label with an optional right-aligned count. */
function SectionCap({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="font-mono text-3xs uppercase tracking-[1px] text-[var(--fg-tertiary)]">{children}</span>
      {aside && <span className="font-mono text-3xs text-[var(--fg-tertiary)]">{aside}</span>}
    </div>
  );
}

/** A labeled form field: a medium label above its control. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col gap-[7px]">
      <span className="text-xs font-medium text-[var(--fg-secondary)]">{label}</span>
      {children}
    </div>
  );
}

/** Outlined "+ Add …" button with an accent plus icon. */
function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onClick}>
      <Plus className="text-[var(--accent-primary)]" aria-hidden /> {children}
    </Button>
  );
}

/** Full-width hairline divider between sections. */
function Divider() {
  return <div className="h-px w-full bg-[var(--border-subtle)]" />;
}
