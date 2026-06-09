import { create } from "zustand";

type ResourceMap = Record<string, Record<string, unknown>>; // kind -> name -> object

interface ClusterState {
  connected: boolean;
  resources: ResourceMap;
  setConnected: (c: boolean) => void;
  upsert: (kind: string, name: string, obj: unknown) => void;
  remove: (kind: string, name: string) => void;
}

export const useCluster = create<ClusterState>((set) => ({
  connected: false,
  resources: {},
  setConnected: (connected) => set({ connected }),
  upsert: (kind, name, obj) =>
    set((s) => ({ resources: { ...s.resources, [kind]: { ...s.resources[kind], [name]: obj } } })),
  remove: (kind, name) =>
    set((s) => {
      const next = { ...s.resources[kind] };
      delete next[name];
      return { resources: { ...s.resources, [kind]: next } };
    }),
}));
