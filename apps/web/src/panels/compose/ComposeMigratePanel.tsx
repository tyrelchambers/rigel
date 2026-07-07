import { useMemo, useRef, useState } from "react";
import { AlertTriangle, FileCode, Info, Layers, Play, Upload } from "lucide-react";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Button } from "@/components/ui/button";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { NamespaceField } from "@/components/NamespaceField";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import type { ActionBlock } from "@/lib/api";
import { convert, combineManifests, type ConversionResult } from "@rigel/compose";
import { readYamlFile } from "@/panels/apply/readYamlFile";

const PLACEHOLDER = `# Paste your docker-compose.yml here, or upload a file.
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
`;

const KIND_LABEL: Record<string, string> = { PersistentVolumeClaim: "PVC" };

function resourceTally(result: ConversionResult | null): string {
  if (!result) return "";
  const counts: Record<string, number> = {};
  for (const m of result.manifests) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
  return Object.entries(counts)
    .map(([kind, n]) => `${KIND_LABEL[kind] ?? kind} ×${n}`)
    .join("   ");
}

export default function ComposeMigratePanel() {
  const [compose, setComposeText] = useState(PLACEHOLDER);
  const [namespace, setNamespace] = useState("default");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data: schema } = useClusterYamlSchema();

  const { result, parseError: convertError } = useMemo<{
    result: ConversionResult | null;
    parseError: string | null;
  }>(() => {
    if (!compose.trim()) return { result: null, parseError: null };
    try {
      return { result: convert(compose, { namespace }), parseError: null };
    } catch (e) {
      return { result: null, parseError: e instanceof Error ? e.message : String(e) };
    }
  }, [compose, namespace]);
  const parseError = fileError ?? convertError;

  function setCompose(next: string) {
    setFileError(null);
    setComposeText(next);
  }

  const manifestYaml = result ? combineManifests(result.manifests) : "";
  const resourceCount = result?.manifests.length ?? 0;

  function handleApply() {
    if (!manifestYaml.trim()) return;
    setPendingAction({ kind: "applyManifest", label: "Apply migrated manifests", manifest: manifestYaml });
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    try {
      const text = await readYamlFile(file);
      setFileError(null);
      setComposeText(text);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  }

  const hints = result?.catalogHints ?? [];
  const warnings = result?.warnings ?? [];
  const hasNotes = hints.length > 0 || warnings.length > 0;

  return (
    <div className="flex h-full flex-col bg-[var(--surface-sunken)]">
      <header className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--surface-primary)] px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <h1 className="font-heading text-xl font-bold tracking-[-0.3px] text-foreground">Migrate from Compose</h1>
          <p className="text-xs text-muted-foreground">
            Turn a docker-compose.yml into Kubernetes manifests you can review and apply
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <NamespaceField value={namespace} onChange={setNamespace} ariaLabel="Target namespace" className="w-40" />
          <input
            ref={fileInput}
            type="file"
            accept=".yaml,.yml,text/yaml"
            hidden
            onChange={(e) => {
              void loadFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileInput.current?.click()}>
            <Upload className="size-3.5" /> Upload
          </Button>
          <Button size="sm" className="gap-1.5" onClick={handleApply} disabled={!manifestYaml.trim()}>
            <Play className="size-3.5 fill-current" /> Apply…
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-[var(--border-subtle)]">
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-2">
            <FileCode className="size-3.5 text-[var(--fg-tertiary)]" />
            <span className="font-mono text-2xs text-[var(--fg-tertiary)]">docker-compose.yml</span>
          </div>
          <div className="min-h-0 flex-1">
            <YamlEditor value={compose} onChange={setCompose} schema={null} />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-2">
            <div className="flex items-center gap-2">
              <Layers className="size-3.5 text-[var(--fg-tertiary)]" />
              <span className="font-mono text-2xs text-[var(--fg-tertiary)]">Generated manifests</span>
            </div>
            <span className="rounded-[4px] border border-[var(--border-subtle)] bg-white/5 px-[9px] py-0.5 font-mono text-2xs text-muted-foreground">
              {resourceCount} resource{resourceCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="min-h-0 flex-1">
            <YamlEditor value={manifestYaml} readOnly schema={schema ?? null} />
          </div>
        </div>
      </div>

      {parseError ? (
        <p className="flex-shrink-0 border-t border-[var(--border-subtle)] bg-destructive/10 px-[18px] py-3 text-xs text-destructive">
          {parseError}
        </p>
      ) : (
        hasNotes && (
          <div className="flex max-h-[200px] flex-shrink-0 flex-col gap-2.5 overflow-auto border-t border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-3.5">
            <span className="font-mono text-2xs text-[var(--fg-tertiary)]">
              {warnings.length} warning{warnings.length === 1 ? "" : "s"} · {hints.length} hint{hints.length === 1 ? "" : "s"}
            </span>
            <div className="flex flex-col gap-2.5">
              {hints.map((h, i) => (
                <div key={`h${i}`} className="flex items-start gap-2.5">
                  <Info className="mt-px size-3.5 shrink-0 text-[var(--accent-primary)]" />
                  <span className="text-xs leading-[1.45] text-muted-foreground">
                    <span className="font-mono">{h.service}</span> looks like {h.appName}. The catalog has a hardened version.
                  </span>
                </div>
              ))}
              {warnings.map((w, i) => (
                <div key={`w${i}`} className="flex items-start gap-2.5">
                  <AlertTriangle
                    className={`mt-px size-3.5 shrink-0 ${w.severity === "warning" ? "text-amber-500" : "text-[var(--fg-tertiary)]"}`}
                  />
                  <span className="text-xs leading-[1.45] text-muted-foreground">
                    {w.service ? <span className="font-mono">{w.service} </span> : null}
                    {w.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      )}

      <footer className="flex flex-shrink-0 items-center justify-between gap-4 border-t border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-2.5">
        <span className="font-mono text-2xs text-[var(--fg-tertiary)]">{resourceTally(result)}</span>
        <span className="text-xs text-[var(--fg-tertiary)]">Nothing is applied until you confirm</span>
      </footer>

      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}
