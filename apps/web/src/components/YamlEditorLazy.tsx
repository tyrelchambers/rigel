// Lazy boundary for the Monaco-based YamlEditor — defers the editor bundle +
// workers until a YAML surface actually renders. Consumers import THIS, never
// the heavy ./YamlEditor module directly.
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import type { YamlEditorProps } from "./YamlEditor";

const Inner = lazy(() => import("./YamlEditor"));

export function YamlEditor(props: YamlEditorProps) {
  return (
    <ErrorBoundary
      surface="YamlEditor"
      fallback={(_error, reset) => (
        <div className="flex flex-col items-start gap-2 p-4 text-xs text-[var(--fg-tertiary)]">
          <span>The editor failed to load.</span>
          <button type="button" className="text-[var(--accent-primary)] hover:underline" onClick={reset}>
            Retry
          </button>
        </div>
      )}
    >
      <Suspense
        fallback={<div className="text-xs" style={{ padding: 16, color: "var(--fg-tertiary)" }}>Loading editor…</div>}
      >
        <Inner {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
