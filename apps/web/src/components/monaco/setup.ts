// One-time Monaco + monaco-yaml bootstrap. Imported by YamlEditor (which is
// itself lazy-loaded), so Monaco's bundle + workers only load when a YAML surface
// first opens. Wires the Vite `?worker` bundles into MonacoEnvironment and binds
// monaco-yaml to the same monaco instance @monaco-editor/react uses.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import yamlWorker from "monaco-yaml/yaml.worker?worker";
import { configureMonacoYaml, type MonacoYaml } from "monaco-yaml";

// Route worker requests: only "yaml" needs the YAML language server.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "yaml") return new yamlWorker();
    return new editorWorker();
  },
};

// Use the locally-bundled monaco (not the CDN) so monaco-yaml attaches to the
// same instance the React wrapper renders.
loader.config({ monaco });

export const HELMSMAN_THEME = "rigel-dark";

// Define the theme EAGERLY (at module load), not lazily in onMount — the editor's
// `theme` prop is applied when Monaco *creates* the editor, which is before
// onMount runs. Defining it here guarantees the name resolves at creation time;
// otherwise Monaco doesn't recognise "rigel-dark" and silently falls back to
// the light `vs` theme. Palette tracks the app tokens (accent #38BDF8, sunken
// surfaces) so the editor reads as part of the dark shell.
monaco.editor.defineTheme(HELMSMAN_THEME, {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5C5F6A", fontStyle: "italic" },
    { token: "type", foreground: "7DD3FC" },        // YAML keys
    { token: "string", foreground: "BEE7A5" },       // scalar values
    { token: "string.yaml", foreground: "BEE7A5" },
    { token: "number", foreground: "F0A479" },
    { token: "keyword", foreground: "C792EA" },       // true/false/null
    { token: "delimiter", foreground: "6B6B73" },
  ],
  colors: {
    "editor.background": "#0B0C0E",
    "editor.foreground": "#E6E7EB",
    "editorGutter.background": "#0B0C0E",
    "editorLineNumber.foreground": "#3A3B42",
    "editorLineNumber.activeForeground": "#38BDF8",
    "editor.lineHighlightBackground": "#15161A",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#38BDF833",
    "editor.inactiveSelectionBackground": "#38BDF820",
    "editorCursor.foreground": "#38BDF8",
    "editorIndentGuide.background1": "#1E1F24",
    "editorIndentGuide.activeBackground1": "#34353C",
    "editorBracketMatch.background": "#38BDF822",
    "editorBracketMatch.border": "#38BDF855",
    "editorWidget.background": "#15161A",
    "editorWidget.border": "#26272B",
    "editorSuggestWidget.background": "#15161A",
    "editorSuggestWidget.border": "#26272B",
    "editorSuggestWidget.selectedBackground": "#38BDF820",
    "editorHoverWidget.background": "#15161A",
    "editorHoverWidget.border": "#26272B",
    "scrollbarSlider.background": "#FFFFFF12",
    "scrollbarSlider.hoverBackground": "#FFFFFF22",
    "scrollbarSlider.activeBackground": "#FFFFFF33",
    "focusBorder": "#00000000",
  },
});

let yamlHandle: MonacoYaml | null = null;

/** Bind monaco-yaml once. Returns the handle so callers can push schema updates
 *  via `.update({ schemas })`. (The theme is defined eagerly above.) */
export function ensureMonacoYaml(m: typeof monaco): MonacoYaml {
  if (!yamlHandle) {
    yamlHandle = configureMonacoYaml(m, {
      enableSchemaRequest: false,
      validate: true,
      format: { enable: true },
      hover: true,
      completion: true,
      schemas: [],
    });
  }
  return yamlHandle;
}
