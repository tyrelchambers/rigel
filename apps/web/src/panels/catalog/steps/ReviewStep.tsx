import { summarizeResources, type CatalogApp } from "@helmsman/catalog";
import { Button } from "@/components/ui/button";
import type { ConfigureValues } from "../wizardLogic";

/**
 * Step 4 — Review. Final substituted manifest/values preview, parsed resource
 * summary, install summary, and the Install button. (docs/parity/catalog.md §"Step 4")
 */
export function ReviewStep({
  app,
  artifact,
  values,
  shapeError,
  onInstall,
  onBack,
}: {
  app: CatalogApp;
  artifact: string;
  values: ConfigureValues;
  /** Non-null when manifest-shape validation failed; install is blocked. */
  shapeError: string | null;
  onInstall: () => void;
  onBack: () => void;
}) {
  const isHelm = app.install?.mode === "helm";
  const resources = isHelm ? [] : summarizeResources(artifact);

  return (
    <div className="space-y-4">
      {/* Install summary */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div className="text-muted-foreground">Instance</div>
        <div className="font-mono">{values.instance}</div>
        <div className="text-muted-foreground">Namespace</div>
        <div className="font-mono">{values.namespace}</div>
        {app.exposesIngress && (
          <>
            <div className="text-muted-foreground">Hostname</div>
            <div className="font-mono">{values.hostname || "—"}</div>
          </>
        )}
        {app.persistence && (
          <>
            <div className="text-muted-foreground">Storage</div>
            <div className="font-mono">{values.storageGiB} GiB</div>
          </>
        )}
        <div className="text-muted-foreground">Mode</div>
        <div className="font-mono">{isHelm ? "helm" : "manifest"}</div>
      </div>

      {/* Resource summary (manifest mode) */}
      {!isHelm && resources.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Resources
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {resources.map((r) => (
              <li
                key={r.kind}
                className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground"
              >
                {r.kind} × {r.count}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Manifest / values preview */}
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {isHelm ? "Values" : "Manifest"}
        </h3>
        <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-3 text-xs font-mono whitespace-pre">
          {artifact}
        </pre>
      </div>

      {shapeError && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap">
          {shapeError}
        </pre>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" disabled={shapeError != null} onClick={onInstall}>
          Install
        </Button>
      </div>
    </div>
  );
}
