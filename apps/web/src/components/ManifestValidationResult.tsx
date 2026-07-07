import { CheckCircle2, Layers, X } from "lucide-react";
import { listResources } from "@rigel/catalog";
import type { ActionResult } from "@/lib/api";

export function ManifestValidationResult({
  state,
  yaml,
  onDismiss,
}: {
  state: { pending: boolean; result?: ActionResult; error?: string };
  yaml: string;
  onDismiss?: () => void;
}) {
  const failMessage = state.error
    ? state.error
    : state.result && state.result.code !== 0
      ? state.result.stderr || state.result.stdout || "Validation failed."
      : null;
  const ok = !failMessage && !!state.result;
  if (!failMessage && !ok) return null;

  const resources = ok ? listResources(yaml) : [];

  return (
    <div className="flex flex-shrink-0 items-start gap-2">
      {ok ? (
        <div className="flex flex-1 flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
            <CheckCircle2 className="size-3.5 shrink-0" /> Valid — {resources.length} resource
            {resources.length === 1 ? "" : "s"} (dry run, nothing applied).
          </p>
          {resources.length > 0 && (
            <ul className="max-h-32 space-y-0.5 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-1.5 text-xs">
              {resources.map((r, i) => (
                <li key={i} className="flex items-center gap-2 rounded-md px-2 py-1 font-mono">
                  <Layers className="size-3 shrink-0 text-[var(--accent-primary)]" />
                  <span className="shrink-0 font-semibold text-[var(--accent-primary)]">{r.kind}</span>
                  <span className="truncate text-foreground/90">{r.name || "—"}</span>
                  {r.namespace && <span className="ml-auto shrink-0 text-3xs text-muted-foreground">{r.namespace}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <pre className="max-h-40 flex-1 overflow-auto whitespace-pre-wrap rounded-lg bg-destructive/10 px-3 py-2.5 font-mono text-xs text-destructive">
          {failMessage}
        </pre>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss validation result"
          onClick={onDismiss}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-[var(--fg-tertiary)] outline-none hover:bg-white/[0.06] hover:text-[var(--fg-primary)]"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
