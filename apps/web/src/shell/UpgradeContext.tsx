import { createContext, use, useMemo, type ReactNode } from "react";

interface UpgradeContextValue {
  openUpgrade: () => void;
}

const UpgradeContext = createContext<UpgradeContextValue | null>(null);

export function UpgradeProvider({
  onUpgrade,
  children,
}: {
  onUpgrade: () => void;
  children: ReactNode;
}) {
  const value = useMemo<UpgradeContextValue>(() => ({ openUpgrade: onUpgrade }), [onUpgrade]);
  return <UpgradeContext value={value}>{children}</UpgradeContext>;
}

export function useUpgrade(): UpgradeContextValue {
  const ctx = use(UpgradeContext);
  if (!ctx) throw new Error("useUpgrade must be used inside <UpgradeProvider>");
  return ctx;
}
