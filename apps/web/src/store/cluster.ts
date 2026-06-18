import { create } from "zustand";

type ResourceMap = Record<string, Record<string, unknown>>; // kind -> name -> object

// Persist the shared namespace selection across reloads. Guarded so the store
// can still be imported in non-browser contexts (tests). `null`/absent = "all".
const NS_FILTER_KEY = "helmsman_namespace_filter";

function readNamespaceFilter(): string | null {
  try {
    return localStorage.getItem(NS_FILTER_KEY);
  } catch {
    return null;
  }
}

function writeNamespaceFilter(ns: string | null): void {
  try {
    if (ns == null) localStorage.removeItem(NS_FILTER_KEY);
    else localStorage.setItem(NS_FILTER_KEY, ns);
  } catch {
    // non-browser / storage disabled — keep in-memory only
  }
}

interface ClusterState {
  connected: boolean;
  resources: ResourceMap;
  /** True between a subscribe request and its first snapshot. */
  isLoading: boolean;
  /** Last watch/connection error message, or null. */
  error: string | null;
  /**
   * Current namespace scope shared across panels. `null` means "all
   * namespaces". Set by the namespace selector elsewhere in the app.
   */
  namespaceFilter: string | null;
  setConnected: (c: boolean) => void;
  setLoading: (l: boolean) => void;
  setError: (e: string | null) => void;
  setNamespaceFilter: (ns: string | null) => void;
  upsert: (kind: string, name: string, obj: unknown) => void;
  remove: (kind: string, name: string) => void;
  /**
   * Replace ALL items for a kind with a fresh set. Used when a watch snapshot
   * arrives: a snapshot is the authoritative full set for the current
   * subscription, so switching namespace (a new subscription → new snapshot)
   * must swap the data, not merge onto the previous namespace's items.
   */
  replaceKind: (kind: string, items: Record<string, unknown>) => void;
  /** A request to focus/open a specific resource after navigation (set by the palette). */
  focusRequest: { route: string; kind: string; key: string } | null;
  setFocusRequest: (f: { route: string; kind: string; key: string } | null) => void;
}

export const useCluster = create<ClusterState>((set) => ({
  connected: false,
  resources: {},
  isLoading: false,
  error: null,
  namespaceFilter: readNamespaceFilter(), // null = All namespaces; restored from localStorage
  setConnected: (connected) => set({ connected }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  setNamespaceFilter: (namespaceFilter) => {
    writeNamespaceFilter(namespaceFilter);
    set({ namespaceFilter });
  },
  upsert: (kind, name, obj) =>
    set((s) => ({ resources: { ...s.resources, [kind]: { ...s.resources[kind], [name]: obj } } })),
  remove: (kind, name) =>
    set((s) => {
      const next = { ...s.resources[kind] };
      delete next[name];
      return { resources: { ...s.resources, [kind]: next } };
    }),
  replaceKind: (kind, items) =>
    set((s) => ({ resources: { ...s.resources, [kind]: items } })),
  focusRequest: null,
  setFocusRequest: (focusRequest) => set({ focusRequest }),
}));
