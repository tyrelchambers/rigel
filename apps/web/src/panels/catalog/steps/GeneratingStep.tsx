import { Sparkles } from "lucide-react";
import type { CatalogApp } from "@rigel/catalog";
import { Button } from "@/components/ui/button";

/**
 * Step 2 — Generating (not-yet-baked apps only). The Claude-generated install
 * path is deferred in the web port (docs/parity/catalog.md §"Dropped Features"):
 * it requires the MCP/chat hook. For a not-yet-baked app we surface the rendered
 * prompt and hand the install off to the main chat rather than silently failing.
 */
export function GeneratingStep({
  app,
  prompt,
  onHandoff,
  onBack,
}: {
  app: CatalogApp;
  prompt: string;
  onHandoff: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Sparkles className="size-5 text-primary" />
        <span className="font-medium">{app.name} needs a generated manifest</span>
      </div>
      <p className="text-sm text-muted-foreground">
        This app isn't baked with a deterministic manifest yet. Hand off to Rigel chat to
        generate and apply the install interactively.
      </p>
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Install prompt
        </h3>
        <pre className="max-h-60 overflow-auto rounded-md bg-muted/40 p-3 text-xs font-mono whitespace-pre-wrap">
          {prompt}
        </pre>
      </div>
      <div className="flex justify-between">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={onHandoff}>
          Continue in chat
        </Button>
      </div>
    </div>
  );
}
