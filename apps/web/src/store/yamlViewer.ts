// Tiny global store for the "View YAML" viewer. Any panel's context menu can
// call `viewYaml(kind, name, namespace)` to open a read-only YAML view of a
// resource; a single <ResourceYamlViewer/> (mounted at the app root) renders it.
import { create } from "zustand";

export interface YamlTarget {
  /** kubectl kind, e.g. "deployment", "pod", "service", "node". */
  kind: string;
  name: string;
  /** Omit for cluster-scoped kinds (node, namespace, pv, clusterrole…). */
  namespace?: string;
  /** Optional display title (defaults to `kind/name`). */
  title?: string;
  /** When true, the viewer offers an Edit→Apply flow (live-resource editing). */
  editable?: boolean;
}

interface YamlViewerState {
  target: YamlTarget | null;
  open: (t: YamlTarget) => void;
  close: () => void;
}

export const useYamlViewer = create<YamlViewerState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/** Open the YAML viewer for a resource — callable from anywhere (context menus). */
export function viewYaml(kind: string, name: string, namespace?: string, title?: string): void {
  useYamlViewer.getState().open({ kind, name, namespace, title });
}

/** Open the YAML viewer in EDITABLE mode — same viewer, plus an Edit→Apply flow
 *  that re-applies the manifest through the guarded ConfirmSheet. Separate entry
 *  point from viewYaml so read-only callers are untouched. */
export function editYaml(kind: string, name: string, namespace?: string, title?: string): void {
  useYamlViewer.getState().open({ kind, name, namespace, title, editable: true });
}
