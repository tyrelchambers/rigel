// Lazy boundary for the Monaco-based YamlEditor — defers the editor bundle +
// workers until a YAML surface actually renders. Consumers import THIS, never
// the heavy ./YamlEditor module directly.
import { lazy, Suspense } from "react";
import type { YamlEditorProps } from "./YamlEditor";

const Inner = lazy(() => import("./YamlEditor"));

export function YamlEditor(props: YamlEditorProps) {
  return (
    <Suspense
      fallback={<div style={{ padding: 16, fontSize: 13, color: "var(--fg-tertiary)" }}>Loading editor…</div>}
    >
      <Inner {...props} />
    </Suspense>
  );
}
