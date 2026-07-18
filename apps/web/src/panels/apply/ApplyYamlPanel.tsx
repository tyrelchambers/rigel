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
import { isYamlFilename, readYamlFile } from "./readYamlFile";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlay, faUpload } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Loader } from "@/components/Loader";
import { ManifestValidationResult } from "@/components/ManifestValidationResult";

// Seeded into the editor as a starting template — real, editable content the
// user can overwrite or clear (not a fake overlay). Multi-doc YAML is supported.
const DEFAULT_MANIFEST = `# Edit this manifest, paste your own, or upload a file.
# Multi-document YAML (separated by ---) is supported.
apiVersion: v1
kind: ConfigMap
metadata:
  name: example
  namespace: default
data:
  hello: world
`;

export default function ApplyYamlPanel() {
  const [yaml, setYaml] = useState(DEFAULT_MANIFEST);
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
    setPendingAction({ kind: "applyManifest", label: "Apply YAML", manifest: yaml, applySource: "apply-yaml" });
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
          <FontAwesomeIcon icon={faUpload} className="size-3.5" /> Upload
        </Button>
        <Button variant="outline" size="sm" onClick={handleValidate} disabled={!hasContent || validate.pending}>
          {validate.pending ? <><Loader size={14} /> Validating…</> : "Validate"}
        </Button>
        <Button size="sm" className="gap-1.5" onClick={handleApply} disabled={!hasContent}>
          <FontAwesomeIcon icon={faPlay} className="size-3.5 fill-current" /> Apply…
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
            borderRadius: 12,
            overflow: "hidden",
            background: "#0B0C0E",
            border: `1px solid ${dragOver ? "var(--accent-primary)" : "#26272B"}`,
            boxShadow: dragOver
              ? "0 0 0 3px color-mix(in srgb, var(--accent-primary) 18%, transparent)"
              : "inset 0 1px 0 rgba(255,255,255,0.02)",
            position: "relative",
            transition: "border-color 120ms ease, box-shadow 120ms ease",
          }}
        >
          <YamlEditor value={yaml} onChange={onChange} schema={schema ?? null} />

          {/* Drag-and-drop affordance — only while a file is over the editor. */}
          {dragOver && (
            <div
              aria-hidden
              style={{
                position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "color-mix(in srgb, var(--accent-primary) 10%, rgba(11,12,14,0.72))",
                backdropFilter: "blur(1px)",
              }}
            >
              <span className="flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium"
                style={{ background: "#15161A", border: "1px solid var(--accent-primary)", color: "var(--accent-primary)" }}>
                <FontAwesomeIcon icon={faUpload} className="size-3.5" /> Drop a .yaml file to load it
              </span>
            </div>
          )}
        </div>

        {uploadError && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" style={{ flexShrink: 0 }}>
            {uploadError}
          </p>
        )}
        <ManifestValidationResult state={validate} yaml={yaml} />
      </div>

      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}
