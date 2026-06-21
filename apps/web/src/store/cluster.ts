import { create } from "zustand";

type ResourceMap = Record<string, Record<string, unknown>>; // kind -> name -> object

/** Safely read `metadata.resourceVersion` off an unknown object. */
function resourceVersionOf(o: unknown): string | undefined {
  return (o as { metadata?: { resourceVersion?: string } } | null | undefined)?.metadata
    ?.resourceVersion;
}

/**
 * Reconcile an incoming snapshot against the previous slice by resourceVersion,
 * reusing existing object references for unchanged items so derived memos stay
 * valid across watch restarts/resyncs/reconnects.
 *
 * Returns the previous slice unchanged (same reference) when nothing was added,
 * removed, or changed — letting the caller skip the `set` entirely.
 */
function reconcileSlice(
  prev: Record<string, unknown> | undefined,
  items: Record<string, unknown>,
): Record<string, unknown> {
  const prevSlice = prev ?? {};
  const next: Record<string, unknown> = {};
  let changed = false;

  for (const key of Object.keys(items)) {
    const incoming = items[key];
    const existing = prevSlice[key];
    const prevRV = resourceVersionOf(existing);
    const nextRV = resourceVersionOf(incoming);
    // Reuse the prior reference only when both sides carry the SAME, present
    // resourceVersion. A missing rV on either side is treated as "changed".
    if (key in prevSlice && prevRV != null && prevRV === nextRV) {
      next[key] = existing;
    } else {
      next[key] = incoming;
      changed = true;
    }
  }

  // Any removed key (present before, absent now) is also a change.
  if (!changed && Object.keys(prevSlice).length !== Object.keys(items).length) {
    changed = true;
  }

  return changed ? next : prevSlice;
}

// Persist the shared namespace selection across reloads. Guarded so the store
// can still be imported in non-browser contexts (tests). `null`/absent = "all".
const NS_FILTER_KEY = "rigel_namespace_filter";

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

// Per-context namespace memory: each kubeconfig context remembers its last
// selected namespace, so switching clusters doesn't carry one cluster's
// namespace onto another. JSON-persisted; absent/parse-failure = {}.
const NS_BY_CONTEXT_KEY = "rigel_namespace_by_context";

function readNamespaceByContext(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(NS_BY_CONTEXT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

function writeNamespaceByContext(map: Record<string, string | null>): void {
  try {
    localStorage.setItem(NS_BY_CONTEXT_KEY, JSON.stringify(map));
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
  /** The active kubeconfig context (cluster) the whole app is pointed at. null
   *  until the rail resolves it from /api/contexts. */
  activeContext: string | null;
  /** Each context's last-selected namespace (null = all). Drives per-cluster
   *  namespace memory across switches. */
  namespaceByContext: Record<string, string | null>;
  /** Initial (no-teardown) set of the active context, used once on load. Adopts
   *  the context's remembered namespace if any; does NOT clear resources. */
  setActiveContextInitial: (context: string) => void;
  /** Switch the active cluster: set context, adopt `namespace`, and clear the
   *  resource cache (stale old-cluster data). The ws layer orchestrates the
   *  actual unsubscribe/resubscribe around this. */
  applySwitch: (context: string, namespace: string | null) => void;
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
  /**
   * Empty the local view for a kind (set `resources[kind]` to `{}`). This only
   * clears the client-side cache; it does not delete server-side objects. For
   * watched kinds (e.g. events) the next snapshot/delta will repopulate it.
   */
  clearKind: (kind: string) => void;
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
  activeContext: null,
  namespaceByContext: readNamespaceByContext(),
  setActiveContextInitial: (context) =>
    set((s) => {
      const remembered = s.namespaceByContext[context];
      return remembered !== undefined
        ? { activeContext: context, namespaceFilter: remembered }
        : { activeContext: context };
    }),
  applySwitch: (context, namespace) => {
    writeNamespaceFilter(namespace);
    set({ activeContext: context, namespaceFilter: namespace, resources: {} });
  },
  setConnected: (connected) => set({ connected }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  setNamespaceFilter: (namespaceFilter) => {
    writeNamespaceFilter(namespaceFilter);
    set((s) => {
      const ctx = s.activeContext;
      if (!ctx) return { namespaceFilter };
      const namespaceByContext = { ...s.namespaceByContext, [ctx]: namespaceFilter };
      writeNamespaceByContext(namespaceByContext);
      return { namespaceFilter, namespaceByContext };
    });
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
    set((s) => {
      const reconciled = reconcileSlice(s.resources[kind], items);
      // Identical to the previous slice → no-op so subscribers don't re-render.
      if (reconciled === s.resources[kind]) return {};
      return { resources: { ...s.resources, [kind]: reconciled } };
    }),
  clearKind: (kind) =>
    set((s) => ({ resources: { ...s.resources, [kind]: {} } })),
  focusRequest: null,
  setFocusRequest: (focusRequest) => set({ focusRequest }),
}));
