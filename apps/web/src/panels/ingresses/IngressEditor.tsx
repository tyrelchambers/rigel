import { useEffect, useMemo, useState } from "react";
import type { Ingress } from "./types";
import type { KVRow } from "@helmsman/k8s";
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
} from "@helmsman/k8s";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { KeyValueEditor } from "../components/KeyValueEditor";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import { Plus, Minus } from "lucide-react";

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

const fieldInput =
  "w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 disabled:cursor-not-allowed";

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
      const res = await fetch("/api/apply", {
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

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[92vh] overflow-auto">
        <SheetHeader>
          <SheetTitle>Edit {name}</SheetTitle>
          <SheetDescription>
            Modify the ingress's class, rules, TLS, and annotations. Name and namespace are preserved.
          </SheetDescription>
        </SheetHeader>

        {/* Form ⇄ YAML toggle */}
        <div className="flex items-center gap-1 px-4">
          <Button size="sm" variant={mode === "form" ? "default" : "outline"} onClick={() => setMode("form")}>Form</Button>
          <Button size="sm" variant={mode === "yaml" ? "default" : "outline"} onClick={enterYaml}>YAML</Button>
        </div>

        {mode === "form" ? (
          <div className="space-y-4 px-4 py-2">
            {/* Identity */}
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="Name">
                <input type="text" value={name} disabled className={fieldInput} />
              </Labeled>
              <Labeled label="Namespace">
                <input type="text" value={namespace} disabled className={fieldInput} />
              </Labeled>
            </div>

            <Labeled label="Ingress class">
              <input
                type="text"
                value={ingressClassName}
                placeholder="nginx"
                onChange={(e) => setIngressClassName(e.target.value)}
                className={fieldInput}
              />
            </Labeled>

            {/* Rules */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Rules</label>
              {rules.map((rule, ri) => (
                <div key={ri} className="space-y-2 rounded-md border bg-background/40 p-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={rule.host}
                      placeholder="host (e.g. helmsman.sh) — blank = all hosts"
                      onChange={(e) => updateRule(ri, { host: e.target.value })}
                      className={fieldInput}
                      aria-label="host"
                    />
                    {rules.length > 1 && (
                      <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove rule" onClick={() => removeRule(ri)}>
                        <Minus className="size-4 text-destructive" aria-hidden />
                      </Button>
                    )}
                  </div>

                  {rule.paths.map((p, pi) => (
                    <div key={pi} className="flex flex-wrap items-center gap-2 pl-3">
                      <input
                        type="text"
                        value={p.path}
                        placeholder="/"
                        onChange={(e) => updatePath(ri, pi, { path: e.target.value })}
                        className={`${fieldInput} w-24`}
                        aria-label="path"
                      />
                      <select
                        value={p.pathType}
                        onChange={(e) => updatePath(ri, pi, { pathType: e.target.value })}
                        className={`${fieldInput} w-44`}
                        aria-label="path type"
                      >
                        {PATH_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <span className="text-xs text-muted-foreground">→</span>
                      <input
                        type="text"
                        value={p.serviceName}
                        placeholder="service"
                        onChange={(e) => updatePath(ri, pi, { serviceName: e.target.value })}
                        className={`${fieldInput} w-32`}
                        aria-label="service name"
                      />
                      <span className="text-xs text-muted-foreground">:</span>
                      <input
                        type="text"
                        value={p.servicePort}
                        placeholder="80"
                        onChange={(e) => updatePath(ri, pi, { servicePort: e.target.value })}
                        className={`${fieldInput} w-20`}
                        aria-label="service port"
                      />
                      {rule.paths.length > 1 && (
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove path" onClick={() => removePath(ri, pi)}>
                          <Minus className="size-4 text-destructive" aria-hidden />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm" className="ml-3" onClick={() => addPath(ri)}>
                    <Plus className="size-3.5" aria-hidden /> Add path
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addRule}>
                <Plus className="size-3.5" aria-hidden /> Add rule
              </Button>
            </div>

            {/* TLS */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">TLS</label>
              {tls.length === 0 && <p className="text-xs text-muted-foreground">No TLS configured.</p>}
              {tls.map((t, ti) => (
                <div key={ti} className="flex flex-wrap items-center gap-2 rounded-md border bg-background/40 p-2">
                  <input
                    type="text"
                    value={t.hosts}
                    placeholder="hosts (comma-separated)"
                    onChange={(e) => updateTls(ti, { hosts: e.target.value })}
                    className={`${fieldInput} flex-1`}
                    aria-label="tls hosts"
                  />
                  <span className="text-xs text-muted-foreground">→</span>
                  <input
                    type="text"
                    value={t.secretName}
                    placeholder="tls-secret"
                    onChange={(e) => updateTls(ti, { secretName: e.target.value })}
                    className={`${fieldInput} w-44`}
                    aria-label="tls secret name"
                  />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove TLS" onClick={() => removeTls(ti)}>
                    <Minus className="size-4 text-destructive" aria-hidden />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addTls}>
                <Plus className="size-3.5" aria-hidden /> Add TLS
              </Button>
            </div>

            {/* Annotations */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Annotations</label>
              <KeyValueEditor rows={annotationRows} onRowsChange={setAnnotationRows} keyPlaceholder="key (e.g. cert-manager.io/cluster-issuer)" />
            </div>

            {labels && Object.keys(labels).length > 0 && (
              <p className="text-xs font-mono text-muted-foreground/70">
                {Object.keys(labels).length} label(s) preserved unchanged.
              </p>
            )}

            {/* Preview */}
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Review the exact command before it runs.</p>
              <pre className="rounded-md bg-muted px-3 py-2 text-xs font-mono">kubectl apply -f -</pre>
              <pre className="max-h-64 overflow-auto rounded-md bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all">
                {builtYaml}
              </pre>
            </div>
          </div>
        ) : (
          <div className="space-y-2 px-4 py-2">
            <p className="text-xs text-muted-foreground">
              Edit the manifest directly. Switching back to <b>Form</b> rebuilds this from the fields (raw edits are discarded). Applied with <code className="font-mono">kubectl apply -f -</code>.
            </p>
            <div className="h-[52vh] w-full overflow-hidden rounded-md border" style={{ background: "#0B0C0E", borderColor: "#26272B" }}>
              <YamlEditor value={yamlText} onChange={setYamlText} schema={schema ?? null} />
            </div>
          </div>
        )}

        {serverError && (
          <pre className="mx-4 rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {serverError}
          </pre>
        )}

        <SheetFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={handleApply} disabled={busy || !valid}>{busy ? "Applying…" : "Apply changes"}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
