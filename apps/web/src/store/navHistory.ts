import { create } from "zustand";

export interface NavEntry {
  path: string;
  context: string | null;
  namespace: string | null;
  focus: { route: string; kind: string; key: string; search?: string } | null;
}

interface NavHistoryState {
  entries: NavEntry[];
  index: number;
  pendingTarget: string | null;
  push: (entry: NavEntry) => void;
  stepBack: () => NavEntry | null;
  stepForward: () => NavEntry | null;
}

export function signature(e: NavEntry): string {
  return `${e.path} ${e.context ?? ""} ${e.namespace ?? ""}`;
}

export const useNavHistoryStore = create<NavHistoryState>((set, get) => ({
  entries: [],
  index: -1,
  pendingTarget: null,

  push: (entry) => {
    if (entry.context === null) return;
    const { entries, index, pendingTarget } = get();
    const sig = signature(entry);
    if (pendingTarget !== null) {
      if (sig === pendingTarget) set({ pendingTarget: null });
      return;
    }
    if (index >= 0 && sig === signature(entries[index])) return;
    const next = entries.slice(0, index + 1);
    next.push(entry);
    set({ entries: next, index: next.length - 1 });
  },

  stepBack: () => {
    const { entries, index } = get();
    if (index <= 0) return null;
    const nextIndex = index - 1;
    const target = entries[nextIndex];
    set({ index: nextIndex, pendingTarget: signature(target) });
    return target;
  },

  stepForward: () => {
    const { entries, index } = get();
    if (index >= entries.length - 1) return null;
    const nextIndex = index + 1;
    const target = entries[nextIndex];
    set({ index: nextIndex, pendingTarget: signature(target) });
    return target;
  },
}));
