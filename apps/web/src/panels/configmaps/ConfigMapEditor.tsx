import { useEffect, useMemo, useState } from "react";
import type { ConfigMap } from "./types";
import type { KVRow } from "@rigel/k8s";
import {
  blankRow,
  buildConfigMapYAML,
  canSubmitConfigMap,
  rowsToConfigMapData,
  seedConfigMapRows,
} from "@rigel/k8s";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KeyValueEditor } from "../components/KeyValueEditor";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";

// ---------------------------------------------------------------------------
// ConfigMapEditor — create/edit form for a ConfigMap
// (docs/parity/configmap-secret-edit.md). Plaintext key/value rows (values are
// often whole config files, so each gets a multi-line textarea). Builds YAML via
// `buildConfigMapYAML` and applies it through POST /api/apply (`kubectl apply
// -f -`). On EDIT: name + namespace are read-only and any `binaryData` is
// carried through unchanged. The watch auto-refreshes the panel after apply.
// ---------------------------------------------------------------------------

interface ApplyResult {
  code: number;
  stdout: string;
  stderr: string;
}

const fieldInput =
  "w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 disabled:cursor-not-allowed";

export interface ConfigMapEditorProps {
  /** `null` = create; a ConfigMap = edit. */
  target: ConfigMap | null;
  open: boolean;
  onClose: () => void;
  /** Called after a successful apply so the panel can close + reset. */
  onApplied?: () => void;
}

export function ConfigMapEditor({ target, open, onClose, onApplied }: ConfigMapEditorProps) {
  const isEdit = target != null;
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [rows, setRows] = useState<KVRow[]>([blankRow()]);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const { data: schema } = useClusterYamlSchema();

  // Binary data is carried through unchanged on edit; the editor never touches it.
  const originalBinaryData = target?.binaryData;

  // (Re)seed the form each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setServerError(null);
    setMode("form");
    if (target) {
      setName(target.metadata.name);
      setNamespace(target.metadata.namespace ?? "default");
      setRows(seedConfigMapRows(target));
    } else {
      setName("");
      setNamespace("default");
      setRows([blankRow()]);
    }
  }, [open, target]);

  const valid = canSubmitConfigMap(name, namespace, rows);

  const yaml = useMemo(
    () =>
      buildConfigMapYAML(
        name.trim(),
        namespace.trim(),
        rowsToConfigMapData(rows),
        originalBinaryData,
      ),
    [name, namespace, rows, originalBinaryData],
  );

  async function handleApply() {
    setServerError(null);
    if (!valid) return;
    setBusy(true);
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: res.statusText }))) as {
          error?: string;
        };
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
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="p-0 gap-0 max-w-3xl max-h-[84vh] overflow-auto">
        <div className="flex flex-col gap-0.5 p-4">
          <DialogTitle>{isEdit ? `Edit ${name}` : "New ConfigMap"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Modify plaintext data. Name, namespace, and any binary data are preserved."
              : "Create a ConfigMap with plaintext key/value data. Multi-line values are supported."}
          </DialogDescription>
        </div>

        {/* Form ⇄ YAML preview toggle */}
        <div className="flex items-center gap-1 px-4 pt-1">
          <Button size="sm" variant={mode === "form" ? "default" : "outline"} onClick={() => setMode("form")}>Form</Button>
          <Button size="sm" variant={mode === "yaml" ? "default" : "outline"} onClick={() => setMode("yaml")}>YAML</Button>
        </div>

        {mode === "form" ? (
        <div className="space-y-4 px-4 py-2">
          {/* Identity */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <input
                type="text"
                value={name}
                placeholder="my-config"
                disabled={isEdit}
                onChange={(e) => setName(e.target.value)}
                className={fieldInput}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Namespace</label>
              <input
                type="text"
                value={namespace}
                placeholder="default"
                disabled={isEdit}
                onChange={(e) => setNamespace(e.target.value)}
                className={fieldInput}
              />
            </div>
          </div>

          {/* Data */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Data</label>
            <KeyValueEditor rows={rows} onRowsChange={setRows} />
          </div>

          {isEdit && originalBinaryData && Object.keys(originalBinaryData).length > 0 && (
            <p className="text-xs font-mono text-muted-foreground/70">
              {Object.keys(originalBinaryData).length} binary key(s) preserved unchanged.
            </p>
          )}

        </div>
        ) : (
          <div className="space-y-2 px-4 py-2">
            <p className="text-xs text-muted-foreground">
              Live preview of the manifest applied with <code className="font-mono">kubectl apply -f -</code>.
            </p>
            <div className="h-[52vh] w-full overflow-hidden rounded-md border" style={{ background: "#0B0C0E", borderColor: "#26272B" }}>
              <YamlEditor value={yaml} readOnly schema={schema ?? null} />
            </div>
          </div>
        )}

        {serverError && (
          <pre className="mx-4 rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {serverError}
          </pre>
        )}

        <div className="mt-auto flex flex-col gap-2 p-4">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={busy || !valid}>
            {busy ? "Applying…" : isEdit ? "Apply changes" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
