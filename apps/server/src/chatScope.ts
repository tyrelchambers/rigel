/** The chat-turn cluster scope, as sent on the WS `chat` frame. */
export type ChatScope = "active" | "all" | { contexts: string[] };

/**
 * Parse an untrusted `scope` value off the WS chat frame into a ChatScope.
 * Anything unrecognized (absent, wrong type, bad shape) defaults to "active" so
 * a malformed frame can never widen the blast radius.
 */
export function parseChatScope(raw: unknown): ChatScope {
  if (raw === "all") return "all";
  if (raw && typeof raw === "object" && Array.isArray((raw as { contexts?: unknown }).contexts)) {
    const contexts = (raw as { contexts: unknown[] }).contexts.filter(
      (c): c is string => typeof c === "string",
    );
    return { contexts };
  }
  return "active";
}

/**
 * Resolve a ChatScope to the active-first, deduped list of REAL contexts the
 * model may read from. `allNames` is the set of known kubeconfig context names
 * (from listContexts). A pick that resolves to nothing falls back to the active
 * context so a fan-out turn never targets zero clusters.
 */
export function resolveReadContexts(
  scope: ChatScope,
  activeContext: string | null,
  allNames: string[],
): string[] {
  if (scope === "active") return activeContext ? [activeContext] : [];
  if (scope === "all") {
    const ordered = activeContext
      ? [activeContext, ...allNames.filter((n) => n !== activeContext)]
      : allNames;
    return [...new Set(ordered)];
  }
  const real = [...new Set(scope.contexts.filter((c) => allNames.includes(c)))];
  if (real.length === 0) return activeContext ? [activeContext] : [];
  if (activeContext && real.includes(activeContext)) {
    return [activeContext, ...real.filter((c) => c !== activeContext)];
  }
  return real;
}
