import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Cpu, MemoryStick, HardDrive, Link2, Unlink, ArrowDownToLine } from "lucide-react";
import { categoryDisplayName, type CatalogApp } from "@helmsman/catalog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
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

/** Detail sheet — full app info + Install button (docs/parity/catalog.md §"Detail Sheet"). */
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="detail-sheet w-full overflow-auto sm:max-w-md">
        <SheetHeader className="detail-sheet-header">
          {/* Icon + title */}
          <div className="detail-sheet-hero">
            <div
              className="detail-sheet-icon"
              style={{ background: "#26262C", border: "1px solid #2F2F36" }}
              aria-hidden
            >
              <Icon className="detail-sheet-icon-glyph" />
            </div>
            <div className="detail-sheet-title-group">
              <SheetTitle className="detail-sheet-name">
                {app.name}
                {isInstalled && (
                  <span className="detail-sheet-installed-badge" aria-label="Installed">
                    <span className="catalog-installed-dot" />
                    Installed
                  </span>
                )}
              </SheetTitle>
              <SheetDescription className="detail-sheet-tagline">{app.tagline}</SheetDescription>
            </div>
          </div>

          {/* Category + resource chips */}
          <div className="detail-sheet-chips">
            <span className="catalog-chip catalog-chip-category">
              {categoryDisplayName(app.category)}
            </span>
            <span className="catalog-chip catalog-chip-req">
              <Cpu className="catalog-chip-icon" aria-hidden />
              {app.requirements.cpuRequest}
              {app.requirements.cpuLimit ? ` → ${app.requirements.cpuLimit}` : ""}
            </span>
            <span className="catalog-chip catalog-chip-req">
              <MemoryStick className="catalog-chip-icon" aria-hidden />
              {app.requirements.memoryRequest}
              {app.requirements.memoryLimit ? ` → ${app.requirements.memoryLimit}` : ""}
            </span>
            {app.requirements.storageGiB != null && (
              <span className="catalog-chip catalog-chip-req">
                <HardDrive className="catalog-chip-icon" aria-hidden />
                {app.requirements.storageGiB} GiB
              </span>
            )}
          </div>
        </SheetHeader>

        <div className="detail-sheet-body">
          {/* Description */}
          <p className="detail-sheet-description">{app.description}</p>

          {/* Links */}
          {activeLinks.length > 0 && (
            <div className="detail-sheet-section">
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

          {/* NODE FIT — per-node capacity + pin-to-node (Swift rightColumn). */}
          <div className="detail-sheet-section">
            <NodeFitPanel
              app={app}
              fit={fit}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
            />
          </div>
        </div>

        <SheetFooter className="detail-sheet-footer">
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
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
