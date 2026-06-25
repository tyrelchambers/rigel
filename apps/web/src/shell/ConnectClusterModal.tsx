import { useEffect, useState } from "react";
import { Cloud, Upload } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { listCloudProviders, type ProviderDescriptor } from "@rigel/cloud-connect/src/index";
import { CLUSTER_ICONS, type IconId } from "./clusterIcons";
import { ConnectWizard } from "./ConnectWizard";
import { ImportKubeconfigPanel } from "./ImportKubeconfigPanel";

type Selection = { kind: "provider"; descriptor: ProviderDescriptor } | { kind: "import" } | null;

const COMING_SOON: { id: IconId; label: string }[] = [
  { id: "aws", label: "Amazon EKS" },
  { id: "gcp", label: "Google GKE" },
  { id: "azure", label: "Azure AKS" },
];

function ProviderTile({
  label, icon, disabled, onClick,
}: { label: string; icon: React.ReactNode; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "16px 10px",
        borderRadius: 10, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1,
        background: "var(--surface-primary)", border: "1px solid var(--border-strong)", color: "var(--fg-primary)",
      }}
    >
      {icon}
      <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
      {disabled ? <span style={{ fontSize: 10, color: "var(--fg-tertiary)" }}>Coming soon</span> : null}
    </button>
  );
}

export function ConnectClusterModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => { if (open) setSelection(null); }, [open]);

  const providers = listCloudProviders();
  const title = selection?.kind === "provider"
    ? `Connect to ${selection.descriptor.displayName}`
    : selection?.kind === "import" ? "Import a kubeconfig" : "Connect a cluster";

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} icon={<Cloud className="size-[17px]" />} maxWidth="!max-w-md">
      {selection === null ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {providers.map((d) => {
            const Icon = CLUSTER_ICONS[d.id].Component;
            return (
              <ProviderTile
                key={d.id}
                label={d.displayName}
                icon={<Icon size={26} />}
                onClick={() => setSelection({ kind: "provider", descriptor: d })}
              />
            );
          })}
          <ProviderTile label="Import a kubeconfig" icon={<Upload size={26} />} onClick={() => setSelection({ kind: "import" })} />
          {COMING_SOON.map((p) => {
            const Icon = CLUSTER_ICONS[p.id].Component;
            return <ProviderTile key={p.id} label={p.label} icon={<Icon size={26} />} disabled />;
          })}
        </div>
      ) : selection.kind === "provider" ? (
        <ConnectWizard descriptor={selection.descriptor} onConnected={() => onOpenChange(false)} />
      ) : (
        <ImportKubeconfigPanel onDone={() => onOpenChange(false)} />
      )}
    </Modal>
  );
}
