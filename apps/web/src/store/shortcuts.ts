import { create } from "zustand";
import type { ShortcutSpec } from "@/lib/platform";
import type { CommandId } from "@/lib/shortcuts/registry";

export const OVERRIDES_KEY = "rigel.shortcuts.overrides";

export type Overrides = Partial<Record<CommandId, ShortcutSpec | null>>;

export function readOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Overrides;
  } catch {
    return {};
  }
}

function persist(overrides: Overrides): void {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    /* ignore quota / private-browsing errors */
  }
}

interface ShortcutState {
  overrides: Overrides;
  setOverride: (id: CommandId, spec: ShortcutSpec | null) => void;
  reset: (id: CommandId) => void;
  resetAll: () => void;
}

export const useShortcutStore = create<ShortcutState>((set) => ({
  overrides: readOverrides(),
  setOverride: (id, spec) =>
    set((s) => {
      const next = { ...s.overrides, [id]: spec };
      persist(next);
      return { overrides: next };
    }),
  reset: (id) =>
    set((s) => {
      const next = { ...s.overrides };
      delete next[id];
      persist(next);
      return { overrides: next };
    }),
  resetAll: () => {
    persist({});
    set({ overrides: {} });
  },
}));
