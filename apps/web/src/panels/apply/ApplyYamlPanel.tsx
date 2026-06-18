// Apply YAML — paste/type/UPLOAD an arbitrary multi-doc manifest in a Monaco
// editor (k8s schema-aware when the cluster schema is available), validate it
// against the apiserver (kubectl apply --dry-run=server), then apply it through
// the same guarded ConfirmSheet every other mutation uses. Cluster-wide: the
// namespace comes from each document, so this panel is NOT namespace-scoped.
import { useRef, useState } from "react";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Button } from "@/components/ui/button";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import { applyManifestYaml, type ActionBlock, type ActionResult } from "@/lib/api";
import { listResources } from "@helmsman/catalog";
import { isYamlFilename, readYamlFile } from "./readYamlFile";
import { CheckCircle2, Layers, LoaderCircle, Play, Upload } from "lucide-react";

const PLACEHOLDER = `# Paste, type, or upload a Kubernetes manifest (multi-doc with --- supported)
apiVersion: v1
kind: ConfigMap
metadata:
  name: example
  namespace: default
data:
  hello: world`;

export default function ApplyYamlPanel() {
  const [yaml, setYaml] = useState("");
  const [validate, setValidate] = useState<{ pending: boolean; result?: ActionResult; error?: string }>({ pending: false });
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data: schema } = useClusterYamlSchema();

  const hasContent = yaml.trim().length > 0;

  async function handleValidate() {
    if (!hasContent) return;
    setValidate({ pending: true });
    try {
      const result = await applyManifestYaml(yaml, true);
      setValidate({ pending: false, result });
    } catch (e) {
      setValidate({ pending: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  function handleApply() {
    if (!hasContent) return;
    setPendingAction({ kind: "applyManifest", label: "Apply YAML", manifest: yaml });
  }

  // Reset stale validation feedback whenever the manifest changes.
  function onChange(next: string) {
    setYaml(next);
    if (validate.result || validate.error) setValidate({ pending: false });
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    try {
      onChange(await readYamlFile(file));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    }
  }

  const yamlDrop = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.files).find((f) => isYamlFilename(f.name));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <PanelHeader title="Apply YAML" subtitle="Create or update resources from a pasted, typed, or uploaded manifest">
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,text/yaml"
          hidden
          onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ""; }}
        />
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileInput.current?.click()}>
          <Upload className="size-3.5" /> Upload
        </Button>
        <Button variant="outline" size="sm" onClick={handleValidate} disabled={!hasContent || validate.pending}>
          {validate.pending ? <><LoaderCircle className="size-3.5 animate-spin" /> Validating…</> : "Validate"}
        </Button>
        <Button size="sm" className="gap-1.5" onClick={handleApply} disabled={!hasContent}>
          <Play className="size-3.5 fill-current" /> Apply…
        </Button>
      </PanelHeader>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void loadFile(yamlDrop(e)); }}
          style={{
            flex: 1,
            minHeight: 0,
            borderRadius: 10,
            overflow: "hidden",
            border: `1px solid ${dragOver ? "var(--accent-primary)" : "#26272B"}`,
            position: "relative",
          }}
        >
          {yaml === "" && (
            <pre
              aria-hidden
              style={{
                position: "absolute", inset: 0, margin: 0, padding: "8px 14px 8px 62px",
                pointerEvents: "none", zIndex: 1, color: "var(--fg-tertiary)",
                fontFamily: "ui-monospace, 'Geist Mono', monospace", fontSize: 12.5, lineHeight: 1.5,
              }}
            >
              {PLACEHOLDER}
            </pre>
          )}
          <YamlEditor value={yaml} onChange={onChange} schema={schema ?? null} />
        </div>

        {uploadError && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" style={{ flexShrink: 0 }}>
            {uploadError}
          </p>
        )}
        <ValidationResult state={validate} yaml={yaml} />
      </div>

      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}

/** Renders the dry-run outcome: a green resource summary on success, the
 *  apiserver's error on failure, or a transport error. */
function ValidationResult({ state, yaml }: { state: { pending: boolean; result?: ActionResult; error?: string }; yaml: string }) {
  if (state.error) return <ResultBox tone="error">{state.error}</ResultBox>;
  if (!state.result) return null;
  if (state.result.code !== 0) {
    return <ResultBox tone="error">{state.result.stderr || state.result.stdout || "Validation failed."}</ResultBox>;
  }
  const resources = listResources(yaml);
  return (
    <div className="flex flex-col gap-1.5" style={{ flexShrink: 0 }}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
        <CheckCircle2 className="size-3.5" /> Valid — {resources.length} resource{resources.length === 1 ? "" : "s"} (dry run, nothing applied).
      </p>
      {resources.length > 0 && (
        <ul className="max-h-32 space-y-0.5 overflow-auto rounded-lg p-1.5 text-xs" style={{ background: "#08080A", border: "1px solid #26272B" }}>
          {resources.map((r, i) => (
            <li key={i} className="flex items-center gap-2 rounded-md px-2 py-1 font-mono">
              <Layers className="size-3 shrink-0" style={{ color: "var(--accent-primary)" }} />
              <span className="shrink-0 font-semibold" style={{ color: "var(--accent-primary)" }}>{r.kind}</span>
              <span className="truncate text-foreground/90">{r.name || "—"}</span>
              {r.namespace && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{r.namespace}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ResultBox({ tone, children }: { tone: "error"; children: React.ReactNode }) {
  return (
    <pre
      className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg px-3 py-2.5 text-xs font-mono"
      style={{ flexShrink: 0, background: tone === "error" ? "rgba(248,113,113,0.10)" : "#08080A", color: "var(--status-failed)", border: "1px solid rgba(248,113,113,0.25)" }}
    >
      {children}
    </pre>
  );
}
