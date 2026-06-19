// Cross-cutting UI state that disconnected components need to trigger
// (e.g. opening the settings modal from a deep chat/onboarding CTA).
import { create } from "zustand";

interface UiState {
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));
