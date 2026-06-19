// apps/web/src/panels/settings/SettingsModal.tsx
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SignalSection, SelfHostSection } from "./SettingsPanel";
import { AgentsTab } from "./agents/AgentsTab";
import { useSettings } from "./useSettings";

type TabId = "general" | "agents" | "integrations" | "about";
const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "integrations", label: "Integrations" },
  { id: "about", label: "About" },
];

export function SettingsModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [tab, setTab] = useState<TabId>("agents");
  // Integrations tab needs the same wiring SettingsPanel used for SignalSection.
  const [applying, setApplying] = useState(false);
  const derived = useSettings(applying);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="w-[calc(100%-2rem)] !max-w-3xl"
        style={{ background: "var(--surface-primary)" }}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>

        {/* Tab bar */}
        <div className="flex gap-1 border-b pb-2" style={{ borderColor: "var(--border-subtle)" }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="rounded-md px-3 py-1.5"
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: tab === t.id ? "var(--fg-primary)" : "var(--fg-tertiary)",
                background: tab === t.id ? "var(--surface-elevated)" : "transparent",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="pt-1">
          {tab === "general" && <SelfHostSection />}
          {tab === "agents" && <AgentsTab />}
          {tab === "integrations" && (
            <SignalSection derived={derived} applying={applying} setApplying={setApplying} />
          )}
          {tab === "about" && (
            <p style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
              Rigel — a self-hostable, AI-native Kubernetes admin UI.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
