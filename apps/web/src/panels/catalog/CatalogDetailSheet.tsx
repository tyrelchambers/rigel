import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Cpu, MemoryStick, HardDrive, Network, Link2, Unlink, ArrowDownToLine } from "lucide-react";
import { categoryDisplayName, type CatalogApp } from "@helmsman/catalog";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import type { Node } from "@/panels/nodes/types";
import type { Pod } from "@/panels/pods/types";
import { iconFor } from "./icons";
import { nodeFit } from "./nodeFit";
import { NodeFitPanel } from "./NodeFitPanel";

/** A workload an app is explicitly bound to via the catalog-app annotation. */
export interface CatalogBinding {
  kind: "deployment" | "statefulset" | "daemonset";
  name: string;
  namespace: string;
  container: string | null;
}

/**
 * Detail sheet — full app info + Install button (docs/parity/catalog.md
 * §"Detail Sheet"). Two-column WIDE modal mirroring Swift's
 * `CatalogDetailSheet`: header on top, a left info column + right NODE FIT
 * column (380px in Swift, 360px here), and a footer with Cancel + Install.
 */
export function CatalogDetailSheet({
  app,
  isInstalled,
  binding,
  open,
  onOpenChange,
  onInstall,
  onLink,
  onUnlink,
}: {
  app: CatalogApp;
  isInstalled: boolean;
  /** The workload this app is bound to via annotation, or null when unbound. */
  binding: CatalogBinding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hands off the app plus the node the user pinned it to (null = "Any"). */
  onInstall: (nodePin: string | null) => void;
  /** Open the workload picker to bind this app to a running workload. */
  onLink: () => void;
  /** Remove the binding annotation(s) for this app. */
  onUnlink: () => void;
}) {
  const Icon = iconFor(app.iconSystemName);

  // Live nodes + pods while the sheet is open, so NODE FIT reflects current
  // capacity. Nodes are cluster-scoped; fit against all pods cluster-wide
  // (ns "*") — matching Swift, which fits against every node + pod.
  const resources = useCluster((s) => s.resources);
  useEffect(() => {
    if (!open) return;
    subscribe("nodes", "*");
    subscribe("pods", "*");
    return () => {
      unsubscribe("nodes", "*");
      unsubscribe("pods", "*");
    };
  }, [open]);

  const nodes = useMemo(
    () => Object.values((resources["nodes"] ?? {}) as Record<string, Node>),
    [resources],
  );
  const pods = useMemo(
    () => Object.values((resources["pods"] ?? {}) as Record<string, Pod>),
    [resources],
  );
  const fit = useMemo(() => nodeFit(app, nodes, pods), [app, nodes, pods]);

  // Node the user pinned in the NODE FIT panel. null = "Any".
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const links: Array<{ label: string; url: string | null | undefined }> = [
    { label: "Docs", url: app.docsURL },
    { label: "Repo", url: app.repoURL },
    { label: "Homepage", url: app.homepageURL },
  ];
  const activeLinks = links.filter((l) => !!l.url);

  // REQUIREMENTS cells — port of Swift's `requirementsBlock` (CPU / Memory /
  // Storage / Ingress), moved out of the header chips into the left column.
  const reqCells: Array<{ icon: typeof Cpu; label: string; value: string }> = [
    {
      icon: Cpu,
      label: "CPU",
      value:
        app.requirements.cpuRequest +
        (app.requirements.cpuLimit ? ` / ${app.requirements.cpuLimit}` : ""),
    },
    {
      icon: MemoryStick,
      label: "Memory",
      value:
        app.requirements.memoryRequest +
        (app.requirements.memoryLimit ? ` / ${app.requirements.memoryLimit}` : ""),
    },
    {
      icon: HardDrive,
      label: "Storage",
      value: app.requirements.storageGiB != null ? `${app.requirements.storageGiB} GiB` : "—",
    },
    {
      icon: Network,
      label: "Ingress",
      value: app.exposesIngress ? "Yes" : "—",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="detail-sheet detail-sheet-modal max-w-none sm:max-w-none"
      >
        {/* ── Header (top, full width) ─────────────────────────────────────── */}
        <div className="detail-sheet-header">
          <div className="detail-sheet-hero">
            <div className="detail-sheet-icon" aria-hidden>
              <Icon className="detail-sheet-icon-glyph" />
            </div>
            <div className="detail-sheet-title-group">
              <DialogTitle className="detail-sheet-name">
                {app.name}
                {isInstalled && (
                  <span className="detail-sheet-installed-badge" aria-label="Installed">
                    <span className="catalog-installed-dot" />
                    Installed
                  </span>
                )}
              </DialogTitle>
              <DialogDescription className="detail-sheet-tagline">
                {app.tagline}
              </DialogDescription>
            </div>
            <button
              type="button"
              className="detail-sheet-close"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
              title="Close"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="size-3.5" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* ── Body: two columns (left info, right NODE FIT) ────────────────── */}
        <div className="detail-sheet-cols">
          {/* Left column — info + REQUIREMENTS. */}
          <div className="detail-sheet-left">
            {/* Category chip */}
            <div className="detail-sheet-chips">
              <span className="catalog-chip catalog-chip-category">
                {categoryDisplayName(app.category)}
              </span>
            </div>

            {/* Description */}
            {app.description && <p className="detail-sheet-description">{app.description}</p>}

            {/* Links */}
            {activeLinks.length > 0 && (
              <div className="detail-sheet-section">
                <h3 className="detail-sheet-section-label">Links</h3>
                <div className="detail-sheet-links">
                  {activeLinks.map((l) => (
                    <a
                      key={l.label}
                      href={l.url ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="detail-sheet-link"
                    >
                      {l.label}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Tags */}
            {app.tags.length > 0 && (
              <div className="detail-sheet-section">
                <h3 className="detail-sheet-section-label">Tags</h3>
                <div className="detail-sheet-tags">
                  {app.tags.map((t) => (
                    <span key={t} className="detail-sheet-tag">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Notes */}
            {app.notes && (
              <div className="detail-sheet-section">
                <h3 className="detail-sheet-section-label">Notes</h3>
                <p className="detail-sheet-notes">{app.notes}</p>
              </div>
            )}

            {/* Workload binding (Link / Unlink) — every app. */}
            <div className="detail-sheet-section">
              <h3 className="detail-sheet-section-label">Linked workload</h3>
              {binding ? (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    Bound to{" "}
                    <span className="font-mono text-foreground">
                      {binding.kind}/{binding.name}
                    </span>{" "}
                    in <span className="font-mono text-foreground">{binding.namespace}</span>
                    {binding.container && (
                      <>
                        {" "}
                        · container{" "}
                        <span className="font-mono text-foreground">{binding.container}</span>
                      </>
                    )}
                  </p>
                  <Button variant="outline" size="sm" onClick={onUnlink} className="self-start gap-1.5">
                    <Unlink className="size-3.5" aria-hidden />
                    Unlink
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    Manually bind this app to a running workload when auto-detection
                    can't match its image (mirror, private registry, or fork).
                  </p>
                  <Button variant="outline" size="sm" onClick={onLink} className="self-start gap-1.5">
                    <Link2 className="size-3.5" aria-hidden />
                    Link a workload…
                  </Button>
                </div>
              )}
            </div>

            {/* Requirements — Swift's `requirementsBlock`. */}
            <div className="detail-sheet-section">
              <h3 className="detail-sheet-section-label">Requirements</h3>
              <div className="detail-sheet-reqs">
                {reqCells.map((cell) => (
                  <div key={cell.label} className="detail-sheet-req-cell">
                    <span className="detail-sheet-req-label">
                      <cell.icon className="catalog-chip-icon" aria-hidden />
                      {cell.label}
                    </span>
                    <span className="detail-sheet-req-value">{cell.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right column — NODE FIT (Swift rightColumn). */}
          <div className="detail-sheet-right">
            <NodeFitPanel
              app={app}
              fit={fit}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
            />
          </div>
        </div>

        {/* ── Footer (bottom, full width) ──────────────────────────────────── */}
        <div className="detail-sheet-footer">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="detail-sheet-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            onClick={() => onInstall(selectedNode)}
            disabled={!fit.anyFits}
            className="detail-sheet-install-btn gap-1.5"
            title={
              fit.anyFits
                ? "Start the install wizard"
                : "No node has enough capacity for this app"
            }
          >
            <ArrowDownToLine className="size-3.5" aria-hidden />
            {selectedNode ? `Install on ${selectedNode}` : "Install on cluster"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
