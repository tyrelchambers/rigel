import { summarizeResources, type CatalogApp } from "@rigel/catalog";
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
  const lineCount = artifact.split("\n").length;

  const summaryRows: Array<[string, string]> = [
    ["Instance", values.instance],
    ["Namespace", values.namespace],
    ...(app.exposesIngress ? ([["Hostname", values.hostname || "—"]] as [string, string][]) : []),
    ...(app.persistence ? ([["Storage", `${values.storageGiB} GiB`]] as [string, string][]) : []),
    ["Mode", isHelm ? "helm" : "manifest"],
  ];

  return (
    <div className="wiz-step">
      {/* Install summary panel */}
      <div className="wiz-review-summary">
        {summaryRows.map(([k, v]) => (
          <div key={k} className="contents">
            <div className="wiz-review-key">{k}</div>
            <div className="wiz-review-val">{v}</div>
          </div>
        ))}
      </div>

      {/* Resource summary (manifest mode) */}
      {!isHelm && resources.length > 0 && (
        <div>
          <h3 className="wiz-section-label">Resources</h3>
          <div className="wiz-chips">
            {resources.map((r) => (
              <span key={r.kind} className="wiz-chip">
                {r.kind} × {r.count}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Manifest / values preview */}
      <div>
        <div className="wiz-code-head">
          <h3 className="wiz-section-label" style={{ marginBottom: 0 }}>
            {isHelm ? "values.yaml" : "Manifest"}
          </h3>
          <span style={{ fontFamily: "var(--font-mono, ui-monospace)", fontSize: 10, color: "var(--fg-tertiary)" }}>
            {lineCount} lines
          </span>
        </div>
        <pre className="max-h-72 overflow-auto p-3 text-xs font-mono whitespace-pre">{artifact}</pre>
      </div>

      {shapeError && <pre className="wiz-error">{shapeError}</pre>}

      <div className="wiz-footer">
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
