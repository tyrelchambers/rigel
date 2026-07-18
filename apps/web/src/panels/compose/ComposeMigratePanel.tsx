import { useEffect, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faCube,
  faChevronDown,
  faChevronUp,
  faDatabase,
  faFileCode,
  faFlask,
  faGlobe,
  faCircleInfo,
  faKey,
  faLayerGroup,
  faPlay,
  faShareNodes,
  faSparkles,
  faTriangleExclamation,
  faUpload,
  faXmark,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Loader } from "@/components/Loader";
import { ManifestValidationResult } from "@/components/ManifestValidationResult";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { NamespaceField } from "@/components/NamespaceField";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import { applyManifestYaml, type ActionBlock, type ActionResult } from "@/lib/api";
import {
  convert,
  combineManifests,
  explainConversion,
  type ConversionResult,
  type ConvertFixes,
  type Explanation,
  type Warning,
} from "@rigel/compose";
import { parseExistingResources, dropManifestDocs } from "@rigel/k8s";
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

const EXPLAIN_ICON: Record<string, IconDefinition> = {
  Deployment: faCube,
  Service: faShareNodes,
  PersistentVolumeClaim: faDatabase,
  Secret: faKey,
  Ingress: faGlobe,
};

const EXPLAIN_LABEL: Record<string, [string, string]> = {
  Deployment: ["Deployment", "Deployments"],
  Service: ["Service", "Services"],
  PersistentVolumeClaim: ["Volume claim", "Volume claims"],
  Secret: ["Secret", "Secrets"],
  Ingress: ["Ingress", "Ingresses"],
};

function explainLabel(kind: string, count: number): string {
  const pair = EXPLAIN_LABEL[kind];
  const label = pair ? (count === 1 ? pair[0] : pair[1]) : kind;
  return `${count} ${label}`;
}

export default function ComposeMigratePanel() {
  const [compose, setComposeText] = useState(PLACEHOLDER);
  const [namespace, setNamespace] = useState("default");
  const [fixes, setFixes] = useState<ConvertFixes>({
    emitSecrets: true,
    bindMountsToPvc: true,
    addWaitInit: true,
    expose: "ingress",
    ingressHost: "example.com",
  });
  const [explainerCollapsed, setExplainerCollapsed] = useState(false);
  const [dryRun, setDryRun] = useState<{ pending: boolean; result?: ActionResult; error?: string }>({ pending: false });
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [editedManifest, setEditedManifest] = useState<string | null>(null);
  const [applyPrep, setApplyPrep] = useState<{ pending: boolean; note?: string }>({ pending: false });
  const [skipped, setSkipped] = useState<{ kind: string; name: string }[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data: schema } = useClusterYamlSchema();

  const { result, parseError: convertError } = useMemo<{
    result: ConversionResult | null;
    parseError: string | null;
  }>(() => {
    if (!compose.trim()) return { result: null, parseError: null };
    try {
      return { result: convert(compose, { namespace, fixes }), parseError: null };
    } catch (e) {
      return { result: null, parseError: e instanceof Error ? e.message : String(e) };
    }
  }, [compose, namespace, fixes]);
  const parseError = fileError ?? convertError;

  function setCompose(next: string) {
    setFileError(null);
    setComposeText(next);
  }

  const explanation: Explanation | null = result ? explainConversion(result) : null;
  const showExplainer = !!explanation && explanation.summary.length > 0;

  const manifestYaml = result ? combineManifests(result.manifests) : "";
  const resourceCount = result?.manifests.length ?? 0;
  // The generated YAML is editable; edits ride on top until the manifest is
  // regenerated (compose/namespace/fixes change), which discards them.
  const effectiveManifest = editedManifest ?? manifestYaml;

  useEffect(() => setEditedManifest(null), [manifestYaml]);
  useEffect(() => {
    setDryRun({ pending: false });
    setSkipped([]);
    setApplyPrep({ pending: false });
  }, [effectiveManifest]);

  // Apply always dry-runs first: validate, and never overwrite a resource that
  // already exists — conflicting resources are dropped and only the new ones
  // are rolled out (through the confirm sheet).
  async function handleApply() {
    if (!effectiveManifest.trim()) return;
    setApplyPrep({ pending: true });
    setSkipped([]);
    try {
      const dry = await applyManifestYaml(effectiveManifest, true);
      setDryRun({ pending: false, result: dry });
      if (dry.code !== 0) {
        setApplyPrep({ pending: false });
        return; // validation failed — surfaced by ManifestValidationResult
      }
      const existing = parseExistingResources(dry.stdout);
      const toApply = existing.length ? dropManifestDocs(effectiveManifest, existing) : effectiveManifest;
      setSkipped(existing);
      if (!toApply.trim()) {
        setApplyPrep({ pending: false, note: "Every resource already exists — nothing new to apply." });
        return;
      }
      setApplyPrep({ pending: false });
      setPendingAction({
        kind: "applyManifest",
        label: existing.length ? `Apply new resources (skip ${existing.length} existing)` : "Apply migrated manifests",
        manifest: toApply,
        applySource: "compose-migration",
      });
    } catch (e) {
      setApplyPrep({ pending: false, note: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleDryRun() {
    if (!effectiveManifest.trim()) return;
    setDryRun({ pending: true });
    try {
      const result = await applyManifestYaml(effectiveManifest, true);
      setDryRun({ pending: false, result });
    } catch (e) {
      setDryRun({ pending: false, error: e instanceof Error ? e.message : String(e) });
    }
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

  function applyFix(w: Warning) {
    const opt = w.fix?.option;
    if (!opt || opt === "expose") return;
    setFixes((f) => ({ ...f, [opt]: true }));
  }

  const activeChips: { key: string; label: string; clear: () => void }[] = [];
  if (fixes.emitSecrets)
    activeChips.push({ key: "secrets", label: "Secrets", clear: () => setFixes((f) => ({ ...f, emitSecrets: false })) });
  if (fixes.bindMountsToPvc)
    activeChips.push({
      key: "pvc",
      label: "Bind mounts → PVC",
      clear: () => setFixes((f) => ({ ...f, bindMountsToPvc: false })),
    });
  const hasIngress = result?.manifests.some((m) => m.kind === "Ingress") ?? false;
  if (fixes.expose === "loadbalancer" || (fixes.expose === "ingress" && hasIngress))
    activeChips.push({
      key: "expose",
      label: `Expose: ${fixes.expose === "loadbalancer" ? "LoadBalancer" : "Ingress"}`,
      clear: () => setFixes((f) => ({ ...f, expose: "none" })),
    });
  if (fixes.addWaitInit)
    activeChips.push({ key: "wait", label: "Wait-for init", clear: () => setFixes((f) => ({ ...f, addWaitInit: false })) });

  const fixBtnClass =
    "flex shrink-0 items-center gap-1 rounded-sm border border-[var(--border-strong)] px-1.5 py-0.5 text-2xs text-[var(--fg-secondary)] outline-none hover:bg-white/[0.04]";
  const hasNotes = hints.length > 0 || warnings.length > 0;
  const showStrip = hasNotes || activeChips.length > 0;

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
            <FontAwesomeIcon icon={faUpload} className="size-3.5" /> Upload
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleDryRun}
            disabled={!effectiveManifest.trim() || dryRun.pending}
          >
            {dryRun.pending ? <><Loader size={14} /> Validating…</> : <><FontAwesomeIcon icon={faFlask} className="size-3.5" /> Dry run</>}
          </Button>
          <Button size="sm" className="gap-1.5" onClick={handleApply} disabled={!effectiveManifest.trim() || applyPrep.pending || dryRun.pending}>
            {applyPrep.pending ? <><Loader size={14} /> Checking…</> : <><FontAwesomeIcon icon={faPlay} className="size-3.5 fill-current" /> Apply…</>}
          </Button>
        </div>
      </header>

      {showExplainer && explanation && (
        <div className="flex flex-shrink-0 flex-col gap-[11px] px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faSparkles} className="size-3.5 text-[var(--accent-primary)]" />
              <h2 className="font-heading text-sm font-semibold text-[var(--fg-primary)]">What this will create</h2>
            </div>
            <Button
              variant="outline"
              size="icon"
              aria-label={explainerCollapsed ? "Expand explainer" : "Collapse explainer"}
              onClick={() => setExplainerCollapsed((c) => !c)}
            >
              {explainerCollapsed ? <FontAwesomeIcon icon={faChevronDown} className="size-4" /> : <FontAwesomeIcon icon={faChevronUp} className="size-4" />}
            </Button>
          </div>

          {!explainerCollapsed && (
            <>
              <p className="text-xs leading-[1.5] text-[var(--fg-secondary)]">{explanation.summary}</p>

              <div className="flex flex-col gap-3">
                {explanation.resources.map((r) => {
                  const Icon = EXPLAIN_ICON[r.kind] ?? faCube;
                  return (
                    <div key={r.kind} className="flex items-start gap-2.5">
                      <FontAwesomeIcon icon={Icon} className="mt-0.5 size-4 shrink-0 text-[var(--accent-primary)]" />
                      <span className="text-xs leading-[1.5]">
                        <span className="font-semibold text-[var(--fg-primary)]">{explainLabel(r.kind, r.count)}</span>
                        <span className="ml-2.5 text-[var(--fg-secondary)]">{r.text}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-[var(--border-subtle)]">
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-2">
            <FontAwesomeIcon icon={faFileCode} className="size-3.5 text-[var(--fg-tertiary)]" />
            <span className="font-mono text-2xs text-[var(--fg-tertiary)]">docker-compose.yml</span>
          </div>
          <div className="min-h-0 flex-1">
            <YamlEditor value={compose} onChange={setCompose} schema={null} />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-2">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faLayerGroup} className="size-3.5 text-[var(--fg-tertiary)]" />
              <span className="font-mono text-2xs text-[var(--fg-tertiary)]">Generated manifests</span>
            </div>
            <span className="rounded-[4px] border border-[var(--border-subtle)] bg-white/5 px-[9px] py-0.5 font-mono text-2xs text-muted-foreground">
              {resourceCount} resource{resourceCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="min-h-0 flex-1">
            <YamlEditor value={effectiveManifest} onChange={setEditedManifest} schema={schema ?? null} />
          </div>
        </div>
      </div>

      {parseError ? (
        <p className="flex-shrink-0 border-t border-[var(--border-subtle)] bg-destructive/10 px-[18px] py-3 text-xs text-destructive">
          {parseError}
        </p>
      ) : (
        <>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-2.5">
            <div className="flex items-center gap-2">
              <label className="text-2xs text-[var(--fg-tertiary)]">Namespace</label>
              <NamespaceField value={namespace} onChange={setNamespace} ariaLabel="Target namespace" className="w-40" />
            </div>
            {fixes.expose === "ingress" && hasIngress && (
              <div className="flex items-center gap-2">
                <label htmlFor="compose-ingress-host" className="text-2xs text-[var(--fg-tertiary)]">
                  Ingress host
                </label>
                <input
                  id="compose-ingress-host"
                  type="text"
                  placeholder="app.example.com"
                  value={fixes.ingressHost ?? ""}
                  onChange={(e) => setFixes((f) => ({ ...f, ingressHost: e.target.value }))}
                  className="w-56 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1 text-xs text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)]"
                />
                <span className="text-2xs text-[var(--fg-tertiary)]">Set your real domain</span>
              </div>
            )}
          </div>
          {showStrip && (
          <div className="flex max-h-[200px] flex-shrink-0 flex-col gap-2.5 overflow-auto border-t border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-3.5">
            {(warnings.length > 0 || hints.length > 0) && (
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-2xs text-[var(--fg-tertiary)]">
                  {warnings.length} warning{warnings.length === 1 ? "" : "s"} · {hints.length} hint{hints.length === 1 ? "" : "s"}
                </span>
              </div>
            )}

            {activeChips.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-2xs text-[var(--fg-tertiary)]">Auto-fixed for you</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {activeChips.map((c) => (
                    <span
                      key={c.key}
                      className="flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-white/[0.03] py-0.5 pl-2 pr-1 text-2xs text-[var(--fg-secondary)]"
                    >
                      {c.label}
                      <button
                        type="button"
                        aria-label={`Undo ${c.label}`}
                        onClick={c.clear}
                        className="flex size-3.5 items-center justify-center rounded-full text-[var(--fg-tertiary)] outline-none hover:bg-white/[0.06] hover:text-[var(--fg-primary)]"
                      >
                        <FontAwesomeIcon icon={faXmark} className="size-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2.5">
              {hints.map((h, i) => (
                <div key={`h${i}`} className="flex items-start gap-2.5">
                  <FontAwesomeIcon icon={faCircleInfo} className="mt-px size-3.5 shrink-0 text-[var(--accent-primary)]" />
                  <span className="text-xs leading-[1.45] text-muted-foreground">
                    <span className="font-mono">{h.service}</span> looks like {h.appName}. The catalog has a hardened version.
                  </span>
                </div>
              ))}
              {warnings.map((w, i) => (
                <div key={`w${i}`} className="flex items-start gap-2.5">
                  <FontAwesomeIcon
                    icon={faTriangleExclamation}
                    className={`mt-px size-3.5 shrink-0 ${w.severity === "warning" ? "text-amber-500" : "text-[var(--fg-tertiary)]"}`}
                  />
                  <span className="flex-1 text-xs leading-[1.45] text-muted-foreground">
                    {w.service ? <span className="font-mono">{w.service} </span> : null}
                    {w.message}
                  </span>
                  {w.fix ? (
                    w.fix.option === "expose" ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger aria-label={`Fix: ${w.message}`} className={fixBtnClass}>
                          Fix <FontAwesomeIcon icon={faChevronDown} className="size-3" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className="text-xs"
                            onClick={() => setFixes((f) => ({ ...f, expose: "loadbalancer" }))}
                          >
                            Expose via LoadBalancer
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-xs"
                            onClick={() => setFixes((f) => ({ ...f, expose: "ingress", ingressHost: f.ingressHost || "example.com" }))}
                          >
                            Add Ingress…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Fix: ${w.message}`}
                        className={fixBtnClass}
                        onClick={() => applyFix(w)}
                      >
                        Fix
                      </button>
                    )
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          )}
        </>
      )}

      {!dryRun.pending && (dryRun.result || dryRun.error) && (
        <div className="flex-shrink-0 border-t border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-2.5">
          <ManifestValidationResult
            state={dryRun}
            yaml={effectiveManifest}
            onDismiss={() => setDryRun({ pending: false })}
          />
        </div>
      )}

      {(skipped.length > 0 || applyPrep.note) && (
        <div className="flex flex-shrink-0 flex-col gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-2.5">
          {skipped.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-amber-400">
              <FontAwesomeIcon icon={faTriangleExclamation} className="size-3.5 shrink-0" /> {skipped.length} resource{skipped.length === 1 ? "" : "s"} already exist and won&apos;t be modified
              {applyPrep.note ? "." : " — only new resources are applied."}
            </p>
          )}
          {skipped.length > 0 && (
            <ul className="max-h-24 space-y-0.5 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-1.5 font-mono text-2xs text-[var(--fg-tertiary)]">
              {skipped.map((r, i) => (
                <li key={i} className="px-2 py-0.5">{r.kind}/{r.name}</li>
              ))}
            </ul>
          )}
          {applyPrep.note && <p className="text-xs text-[var(--fg-secondary)]">{applyPrep.note}</p>}
        </div>
      )}

      <footer className="flex flex-shrink-0 items-center justify-between gap-4 border-t border-[var(--border-subtle)] bg-[var(--surface-primary)] px-[18px] py-2.5">
        <span className="font-mono text-2xs text-[var(--fg-tertiary)]">{resourceTally(result)}</span>
        <span className="text-xs text-[var(--fg-tertiary)]">Nothing is applied until you confirm</span>
      </footer>

      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}
