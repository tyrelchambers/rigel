import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useCluster } from "@/store/cluster";
import { switchCluster } from "@/lib/ws";
import { useNavHistoryStore, type NavEntry } from "@/store/navHistory";

/**
 * Browser-style back/forward for the top header. Records every location change
 * (route + cluster + namespace + pending focus) and replays entries on step.
 */
export function useNavHistory() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeContext = useCluster((s) => s.activeContext);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const index = useNavHistoryStore((s) => s.index);
  const entriesLength = useNavHistoryStore((s) => s.entries.length);
  const canGoBack = index > 0;
  const canGoForward = index < entriesLength - 1;

  // Record every location change; the store's push() guard decides what sticks.
  useEffect(() => {
    useNavHistoryStore.getState().push({
      path: pathname,
      context: activeContext,
      namespace: namespaceFilter,
      focus: useCluster.getState().focusRequest,
    });
  }, [pathname, activeContext, namespaceFilter]);

  function applyEntry(entry: NavEntry) {
    const cluster = useCluster.getState();
    if (entry.context && entry.context !== cluster.activeContext) {
      switchCluster(entry.context);
    }
    if (entry.namespace !== useCluster.getState().namespaceFilter) {
      useCluster.getState().setNamespaceFilter(entry.namespace);
    }
    navigate(entry.path);
    if (entry.focus) useCluster.getState().setFocusRequest(entry.focus);
  }

  function goBack() {
    const entry = useNavHistoryStore.getState().stepBack();
    if (entry) applyEntry(entry);
  }

  function goForward() {
    const entry = useNavHistoryStore.getState().stepForward();
    if (entry) applyEntry(entry);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "[" || e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      } else if (e.key === "]" || e.key === "ArrowRight") {
        e.preventDefault();
        goForward();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // goBack/goForward only read live state via getState(); navigate is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { canGoBack, canGoForward, goBack, goForward };
}
