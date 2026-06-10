import { ExternalLink, Cpu, MemoryStick, HardDrive } from "lucide-react";
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
import { iconFor } from "./icons";
import { appIconGradient } from "./appColors";

/** Detail sheet — full app info + Install button (docs/parity/catalog.md §"Detail Sheet"). */
export function CatalogDetailSheet({
  app,
  isInstalled,
  open,
  onOpenChange,
  onInstall,
}: {
  app: CatalogApp;
  isInstalled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: () => void;
}) {
  const Icon = iconFor(app.iconSystemName);
  const gradient = appIconGradient(app.id);
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
              style={{ background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})` }}
              aria-hidden
            >
              <Icon className="detail-sheet-icon-glyph" />
              <div className="detail-sheet-icon-highlight" />
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
        </div>

        <SheetFooter className="detail-sheet-footer">
          <Button
            onClick={onInstall}
            className="detail-sheet-install-btn"
          >
            {isInstalled ? "Reinstall" : "Install"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
