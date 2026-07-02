// Reusable Monaco code editor (DEFAULT export so it can be React.lazy()'d — keeps
// Monaco out of the initial bundle). Defaults to YAML with the monaco-yaml
// language server; pass `language` (e.g. "json" | "plaintext") to reuse the same
// themed editor for other content, such as a ConfigMap key's plaintext value. The
// optional `schema` (the live cluster JSON Schema) drives YAML autocomplete +
// inline validation and is ignored for non-YAML languages.
import { useEffect, useId, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { ensureMonacoYaml, HELMSMAN_THEME } from "./monaco/setup";

export interface YamlEditorProps {
  value: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  /** Cluster JSON Schema for validation/autocomplete, or null for lint-only. YAML only. */
  schema?: Record<string, unknown> | null;
  /** CSS height; defaults to filling the parent. */
  height?: string;
  /** Monaco language id. Defaults to "yaml" (monaco-yaml features apply only then). */
  language?: string;
}

export default function YamlEditor({ value, onChange, readOnly, schema, height = "100%", language = "yaml" }: YamlEditorProps) {
  const isYaml = language === "yaml";
  const yamlRef = useRef<ReturnType<typeof ensureMonacoYaml> | null>(null);
  // Unique in-memory model URI per instance so concurrently-mounted editors
  // never share a Monaco model. monaco-yaml's `fileMatch: ["*"]` applies the
  // schema to every YAML model regardless of URI; non-YAML models are untouched.
  //
  // Accepted constraint: monaco-yaml's handle (from ensureMonacoYaml) is a
  // module-level singleton, so `update({ schemas })` sets the schema list
  // GLOBALLY — if two YAML editors mounted at once carried *different* schemas,
  // the last to apply would win for both. That can't happen here: every YAML
  // editor is fed the same cluster schema (useClusterYamlSchema), so this is safe.
  const ext = isYaml ? "yaml" : language === "json" ? "json" : "txt";
  const modelUri = `inmemory://model/${useId().replace(/:/g, "")}.${ext}`;

  function applySchema() {
    // Only touch monaco-yaml for YAML editors — otherwise a plaintext/JSON editor
    // mounting would clear the schema list globally and break an open YAML editor.
    if (!isYaml) return;
    yamlRef.current?.update({
      enableSchemaRequest: false,
      schemas: schema
        ? [{ uri: "inmemory://schema/kubernetes.json", fileMatch: ["*"], schema }]
        : [],
    });
  }

  const handleMount: OnMount = (_editor, monaco) => {
    if (isYaml) {
      yamlRef.current = ensureMonacoYaml(monaco);
      applySchema();
    }
  };

  // Push schema changes (it may arrive after the editor mounts) into monaco-yaml.
  useEffect(() => {
    applySchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  return (
    <Editor
      height={height}
      language={language}
      theme={HELMSMAN_THEME}
      path={modelUri}
      value={value}
      onChange={(v) => onChange?.(v ?? "")}
      onMount={handleMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        lineHeight: 21,
        lineNumbers: "on",
        lineDecorationsWidth: 14,
        lineNumbersMinChars: 3,
        tabSize: 2,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontFamily: "ui-monospace, 'Geist Mono', monospace",
        fontLigatures: true,
        padding: { top: 14, bottom: 14 },
        renderLineHighlight: "all",
        roundedSelection: true,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        guides: { indentation: true, bracketPairs: false },
        overviewRulerLanes: 0,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        stickyScroll: { enabled: false },
      }}
      loading={<div style={{ padding: 16, fontSize: 13, color: "var(--fg-tertiary)" }}>Loading editor…</div>}
    />
  );
}
