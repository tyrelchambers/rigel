// apps/web/src/panels/settings/SettingsModal.tsx
import { useState } from "react";
import { TabModal, type ModalTab } from "@/components/ui/modal";
import { SignalSection, SelfHostSection } from "./SettingsPanel";
import { AgentsTab } from "./agents/AgentsTab";
import { useSettings } from "./useSettings";

export function SettingsModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  // Integrations tab needs the same wiring SettingsPanel used for SignalSection.
  const [applying, setApplying] = useState(false);
  const derived = useSettings(applying);

  const tabs: ModalTab[] = [
    { id: "general", label: "General", content: <SelfHostSection /> },
    { id: "agents", label: "Agents", content: <AgentsTab /> },
    {
      id: "integrations",
      label: "Integrations",
      content: <SignalSection derived={derived} applying={applying} setApplying={setApplying} />,
    },
    {
      id: "about",
      label: "About",
      content: (
        <p style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
          Rigel — a self-hostable, AI-native Kubernetes admin UI.
        </p>
      ),
    },
  ];

  return (
    <TabModal
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      defaultTab="agents"
      maxWidth="!max-w-3xl"
      tabs={tabs}
    />
  );
}
