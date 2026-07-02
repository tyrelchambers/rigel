import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  FilePenLine,
  FilePlus2,
  GripVertical,
  Info,
  Lock,
  Plus,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-react";
import type { ConfigMap } from "./types";
import type { KVRow } from "@rigel/k8s";
import {
  blankRow,
  buildConfigMapYAML,
  canSubmitConfigMap,
  rowsToConfigMapData,
  seedConfigMapRows,
} from "@rigel/k8s";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import { useCopyToClipboard } from "@/lib/useCopyToClipboard";
import { KindBadge } from "./KindBadge";
import { humanBytes, plaintextBytes, valueKind, valueLines } from "./configmapsDisplay";

// ---------------------------------------------------------------------------
// ConfigMapEditor — create/edit form for a ConfigMap. Reproduces Pencil frame
// zheCV ("ConfigMap — Edit modal (improved)") inside our standard Dialog shell
// (never a hand-rolled modal): header with accent tile + title, Form ⇄ YAML
// segmented toggle, locked Name/Namespace on edit, and per-key "data cards" whose
// value is edited in the shared Monaco editor (YamlEditor with a detected
// language). Builds YAML via `buildConfigMapYAML` and applies it through
// POST /api/apply (`kubectl apply -f -`). On EDIT: name + namespace are read-only
// and any `binaryData` is carried through unchanged. See
// docs/parity/configmap-secret-edit.md. The watch auto-refreshes after apply.
// ---------------------------------------------------------------------------

interface ApplyResult {
  code: number;
  stdout: string;
  stderr: string;
}

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
  const binaryCount = originalBinaryData ? Object.keys(originalBinaryData).length : 0;

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
      buildConfigMapYAML(name.trim(), namespace.trim(), rowsToConfigMapData(rows), originalBinaryData),
    [name, namespace, rows, originalBinaryData],
  );

  function updateRow(idx: number, patch: Partial<KVRow>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, blankRow()]);
  }
  function removeRow(idx: number) {
    setRows((rs) => rs.filter((_, i) => i !== idx));
  }

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

  const TileIcon = isEdit ? FilePenLine : FilePlus2;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[86vh] w-[calc(100%-2rem)] max-w-[760px] flex-col gap-0 overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-elevated)] p-0 ring-0"
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-6 pb-[18px] pt-[22px]">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-[var(--accent-primary)]/[0.15]">
              <TileIcon className="size-[18px] text-[var(--accent-primary)]" />
            </div>
            <div className="flex flex-col gap-[3px]">
              <DialogTitle className="flex items-center gap-2 font-heading text-[20px] font-bold leading-tight text-foreground">
                {isEdit ? (
                  <>
                    <span>Edit</span>
                    <span className="font-mono text-[19px] font-semibold">{name}</span>
                  </>
                ) : (
                  "New ConfigMap"
                )}
              </DialogTitle>
              <DialogDescription className="text-[13px] text-[var(--fg-tertiary)]">
                {isEdit
                  ? "Modify plaintext data. Name, namespace, and binary data are preserved."
                  : "Create a ConfigMap with plaintext key/value data. Multi-line values are supported."}
              </DialogDescription>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-[var(--fg-secondary)] transition-colors hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
          {/* Form ⇄ YAML segmented toggle */}
          <div className="inline-flex w-fit gap-[2px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-[3px]">
            {(["form", "yaml"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded px-[18px] py-[7px] text-[13px] transition-colors ${
                  mode === m
                    ? "bg-[var(--accent-primary)] font-semibold text-[var(--fg-inverse)]"
                    : "font-medium text-[var(--fg-secondary)] hover:text-foreground"
                }`}
              >
                {m === "form" ? "Form" : "YAML"}
              </button>
            ))}
          </div>

          {mode === "form" ? (
            <>
              {/* Identity */}
              <div className="flex gap-4">
                <IdentityField label="Name" locked={isEdit}>
                  {isEdit ? (
                    <LockedValue value={name} />
                  ) : (
                    <TextField value={name} onChange={setName} placeholder="my-config" />
                  )}
                </IdentityField>
                <IdentityField label="Namespace" locked={isEdit}>
                  {isEdit ? (
                    <LockedValue value={namespace} />
                  ) : (
                    <TextField value={namespace} onChange={setNamespace} placeholder="default" />
                  )}
                </IdentityField>
              </div>

              {/* Data */}
              <div className="flex flex-col gap-[9px]">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-[var(--fg-secondary)]">Data</span>
                  <span className="font-mono text-[11px] text-[var(--fg-tertiary)]">
                    {rows.length} {rows.length === 1 ? "key" : "keys"} · plaintext
                  </span>
                </div>

                {rows.map((row, idx) => (
                  <DataKeyCard
                    key={row.id}
                    row={row}
                    canRemove={rows.length > 1}
                    onChange={(patch) => updateRow(idx, patch)}
                    onRemove={() => removeRow(idx)}
                  />
                ))}

                <button
                  type="button"
                  onClick={addRow}
                  className="flex w-full items-center justify-center gap-[7px] rounded-md border border-[var(--border-subtle)] bg-white/[0.02] px-[14px] py-[11px] text-[13px] font-semibold text-[var(--fg-secondary)] transition-colors hover:bg-white/[0.04] hover:text-foreground"
                >
                  <Plus className="size-[15px]" aria-hidden /> Add key
                </button>

                {isEdit && binaryCount > 0 && (
                  <p className="font-mono text-[11px] text-[var(--fg-tertiary)]">
                    {binaryCount} binary key{binaryCount === 1 ? "" : "s"} preserved unchanged.
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[12px] text-[var(--fg-tertiary)]">
                Live preview of the manifest applied with{" "}
                <code className="font-mono">kubectl apply -f -</code>.
              </p>
              <div className="h-[48vh] w-full overflow-hidden rounded-md border border-[var(--border-subtle)]">
                <YamlEditor value={yaml} readOnly schema={schema ?? null} />
              </div>
            </div>
          )}

          {serverError && (
            <pre className="rounded-md bg-[var(--status-failed)]/10 px-3 py-2 font-mono text-xs text-[var(--status-failed)] whitespace-pre-wrap break-all">
              {serverError}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-6 pb-5 pt-4">
          <div className="flex items-center gap-[7px]">
            <TriangleAlert className="size-[13px] text-[var(--fg-tertiary)]" aria-hidden />
            <span className="text-[12.5px] text-[var(--fg-tertiary)]">
              {isEdit
                ? "Changes apply immediately to the live cluster."
                : "Creates a new ConfigMap in the cluster."}
            </span>
          </div>
          <div className="flex items-center gap-[10px]">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-[var(--border-strong)] px-5 py-[11px] text-[14px] font-semibold text-[var(--fg-secondary)] transition-colors hover:text-foreground disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={busy || !valid}
              className="flex items-center gap-2 rounded-md bg-[var(--accent-primary)] px-[22px] py-[11px] text-[14px] font-bold text-[var(--fg-inverse)] transition-opacity disabled:opacity-60"
            >
              <Check className="size-[15px]" aria-hidden />
              {busy ? "Applying…" : isEdit ? "Apply changes" : "Create"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Identity fields (Name / Namespace).
// ---------------------------------------------------------------------------

function IdentityField({
  label,
  locked,
  children,
}: {
  label: string;
  locked: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col gap-[7px]">
      <div className="flex items-center gap-[7px]">
        <span className="text-[13px] font-medium text-[var(--fg-secondary)]">{label}</span>
        {locked && (
          <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-[7px] py-px">
            <Lock className="size-[10px] text-[var(--fg-tertiary)]" aria-hidden />
            <span className="font-mono text-[10px] tracking-[0.3px] text-[var(--fg-tertiary)]">Preserved</span>
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function TextField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[14px] py-[12px] font-mono text-[14px] text-[var(--fg-primary)] outline-none transition-colors placeholder:text-[var(--fg-tertiary)] focus:border-[var(--accent-primary)]"
    />
  );
}

function LockedValue({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[14px] py-[12px]">
      <span className="truncate font-mono text-[14px] font-medium text-[var(--fg-secondary)]">{value}</span>
      <span className="flex-1" />
      <Lock className="size-[14px] shrink-0 text-[var(--fg-tertiary)]" aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-key data card: editable key name + detected-kind/size badges + copy/delete
// and a Monaco value editor (shared YamlEditor with the detected language).
// ---------------------------------------------------------------------------

function DataKeyCard({
  row,
  canRemove,
  onChange,
  onRemove,
}: {
  row: KVRow;
  canRemove: boolean;
  onChange: (patch: Partial<KVRow>) => void;
  onRemove: () => void;
}) {
  const { copied, copy } = useCopyToClipboard();
  const kind = valueKind(row.key, row.value);
  const bytes = plaintextBytes(row.value);
  const lineCount = Math.max(1, valueLines(row.value).length);
  const editorHeight = Math.min(320, Math.max(120, lineCount * 21 + 28));
  const lang = kind === "json" ? "json" : kind === "yaml" ? "yaml" : "plaintext";
  const detected =
    kind === "certificate"
      ? "Detected certificate"
      : kind === "json"
        ? "Detected JSON"
        : kind === "yaml"
          ? "Detected YAML"
          : "Plain text";

  return (
    <div className="overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-primary)] transition-colors focus-within:border-[var(--accent-primary)]/60">
      {/* Header */}
      <div className="flex items-center gap-[9px] border-b border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3 py-[9px]">
        <GripVertical className="size-[14px] shrink-0 text-[var(--fg-tertiary)]" aria-hidden />
        <input
          type="text"
          value={row.key}
          placeholder="key"
          aria-label="key"
          onChange={(e) => onChange({ key: e.target.value })}
          className="w-[180px] rounded-sm border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[10px] py-[5px] font-mono text-[13px] font-medium text-foreground outline-none transition-colors focus:border-[var(--accent-primary)]"
        />
        <KindBadge kind={kind} />
        <span className="rounded-sm bg-white/[0.05] px-[7px] py-[2px] font-mono text-[11px] text-[var(--fg-tertiary)]">
          {humanBytes(bytes)}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => copy(row.value)}
          aria-label="Copy value"
          className="text-[var(--fg-tertiary)] transition-colors hover:text-foreground"
        >
          {copied ? (
            <Check className="size-[15px] text-[var(--status-running)]" />
          ) : (
            <Copy className="size-[15px]" />
          )}
        </button>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove key"
            className="text-[var(--fg-tertiary)] transition-colors hover:text-[var(--status-failed)]"
          >
            <Trash2 className="size-[15px]" />
          </button>
        )}
      </div>

      {/* Value editor (Monaco) */}
      <div className="bg-[var(--surface-sunken)]">
        <YamlEditor
          value={row.value}
          onChange={(v) => onChange({ value: v })}
          language={lang}
          height={`${editorHeight}px`}
        />
      </div>

      {/* Footer: detection + size */}
      <div className="flex items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3 py-[7px]">
        <span className="flex items-center gap-[7px]">
          <Info className="size-[12px] text-[var(--fg-tertiary)]" aria-hidden />
          <span className="text-[12px] text-[var(--fg-tertiary)]">{detected}</span>
        </span>
        <span className="font-mono text-[11px] text-[var(--fg-tertiary)]">{humanBytes(bytes)}</span>
      </div>
    </div>
  );
}
