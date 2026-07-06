import { useEffect } from "react";
import { useCluster } from "@/store/cluster";
import { focusKeyFor } from "@/lib/resourceNav";

/**
 * When a focusRequest targets this panel's kind, expand and scroll the matching
 * row, then clear the request. `rowKeyOf` returns the panel's own row key (used
 * for expand state + the data-row-key attribute); matching uses focusKeyFor
 * (uid-preferred) to agree with goToResource and the command palette.
 *
 * When the request carries a `search` term, `applySearch` seeds the panel's
 * search box (called as soon as the request arrives, so the list narrows even
 * before the row streams in).
 */
export function useFocusRow<T extends { metadata: { uid?: string; name: string; namespace?: string } }>(
  focusKind: string,
  items: T[],
  rowKeyOf: (o: T) => string,
  expand: (rowKey: string) => void,
  applySearch?: (term: string) => void,
): void {
  const focusRequest = useCluster((s) => s.focusRequest);
  const setFocusRequest = useCluster((s) => s.setFocusRequest);
  useEffect(() => {
    if (focusRequest?.kind !== focusKind) return;
    if (focusRequest.search != null && applySearch) applySearch(focusRequest.search);
    const match = items.find((o) => focusKeyFor(o) === focusRequest.key);
    if (!match) return;
    const k = rowKeyOf(match);
    expand(k);
    setFocusRequest(null);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-row-key="${CSS.escape(k)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, items]);
}
