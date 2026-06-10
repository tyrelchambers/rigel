import { ExternalLink } from "lucide-react";
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
import { requirementsSummary } from "./catalogDisplay";

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
  const links: Array<{ label: string; url: string | null | undefined }> = [
    { label: "Docs", url: app.docsURL },
    { label: "Repo", url: app.repoURL },
    { label: "Homepage", url: app.homepageURL },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-auto sm:max-w-md">
        <SheetHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-muted">
              <Icon className="size-5" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="flex items-center gap-2">
                {app.name}
                {isInstalled && (
                  <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                    installed
                  </span>
                )}
              </SheetTitle>
              <SheetDescription>{app.tagline}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-4">
          {/* Category + requirements */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5">
              {categoryDisplayName(app.category)}
            </span>
            <span className="font-mono">{requirementsSummary(app)}</span>
          </div>

          {/* Description */}
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{app.description}</p>

          {/* Requirements detail */}
          <div className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Requirements
            </h3>
            <ul className="space-y-0.5 text-xs font-mono text-muted-foreground">
              <li>
                cpu: {app.requirements.cpuRequest}
                {app.requirements.cpuLimit ? ` → ${app.requirements.cpuLimit}` : ""}
              </li>
              <li>
                memory: {app.requirements.memoryRequest}
                {app.requirements.memoryLimit ? ` → ${app.requirements.memoryLimit}` : ""}
              </li>
              {app.requirements.storageGiB != null && (
                <li>storage: {app.requirements.storageGiB} GiB</li>
              )}
            </ul>
          </div>

          {/* Links */}
          <div className="flex flex-wrap gap-2">
            {links
              .filter((l) => !!l.url)
              .map((l) => (
                <a
                  key={l.label}
                  href={l.url ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                >
                  {l.label}
                  <ExternalLink className="size-3" />
                </a>
              ))}
          </div>

          {/* Tags */}
          {app.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {app.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          {/* Notes */}
          {app.notes && (
            <div className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Notes
              </h3>
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">{app.notes}</p>
            </div>
          )}
        </div>

        <SheetFooter>
          <Button onClick={onInstall}>{isInstalled ? "Reinstall" : "Install"}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
