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

export const HELMSMAN_THEME = "helmsman-dark";

let themeDefined = false;
let yamlHandle: MonacoYaml | null = null;

/** Idempotently define the app theme + bind monaco-yaml. Returns the monaco-yaml
 *  handle so callers can push schema updates via `.update({ schemas })`. */
export function ensureMonacoYaml(m: typeof monaco): MonacoYaml {
  if (!themeDefined) {
    m.editor.defineTheme(HELMSMAN_THEME, {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#08080A",
        "editorLineNumber.foreground": "#3A3A40",
        "editor.lineHighlightBackground": "#141417",
      },
    });
    themeDefined = true;
  }
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
