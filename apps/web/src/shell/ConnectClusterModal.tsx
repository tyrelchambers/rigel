import { useEffect, useState } from "react";
import { Cloud, Lock, Upload } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";
import { listCloudProviders, type ProviderDescriptor } from "@rigel/cloud-connect/src/index";
import { CLUSTER_ICONS } from "./clusterIcons";
import { ConnectWizard } from "./ConnectWizard";
import { ImportKubeconfigPanel } from "./ImportKubeconfigPanel";
import { useEntitlement } from "./useEntitlement";
import { useUpgrade } from "./UpgradeContext";

type Selection = { kind: "provider"; descriptor: ProviderDescriptor } | { kind: "import" } | null;

function ProviderTile({
  label, icon, disabled, locked, onClick,
}: { label: string; icon: React.ReactNode; disabled?: boolean; locked?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        position: "relative",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "16px 10px",
        borderRadius: 10, cursor: disabled ? "default" : "pointer", opacity: disabled || locked ? 0.5 : 1,
        background: "var(--surface-primary)", border: "1px solid var(--border-strong)", color: "var(--fg-primary)",
      }}
    >
      {locked ? (
        <span
          aria-hidden
          style={{
            position: "absolute", top: 8, right: 8,
            width: 18, height: 18, borderRadius: 999,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--surface-elevated)", border: "1px solid var(--border-strong)",
          }}
        >
          <Lock size={11} style={{ color: "var(--fg-secondary)" }} />
        </span>
      ) : null}
      {icon}
      <span className="text-xs" style={{ fontWeight: 600 }}>{label}</span>
      {disabled ? (
        <span className="text-3xs" style={{ color: "var(--fg-tertiary)" }}>Coming soon</span>
      ) : locked ? (
        <span className="text-3xs" style={{ color: "var(--accent-primary)" }}>Pro</span>
      ) : null}
    </button>
  );
}

export function ConnectClusterModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => { if (open) setSelection(null); }, [open]);

  const { payload } = useEntitlement();
  const cloudUnlocked = !!payload?.cloudConnect;
  const { openUpgrade } = useUpgrade();

  const providers = listCloudProviders();
  const title = selection?.kind === "provider"
    ? `Connect to ${selection.descriptor.displayName}`
    : selection?.kind === "import" ? "Import a kubeconfig" : "Connect a cluster";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon>
            <Cloud className="size-[17px]" />
          </DialogIcon>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
      {selection === null ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {providers.map((d) => {
            const Icon = CLUSTER_ICONS[d.id].Component;
            return (
              <ProviderTile
                key={d.id}
                label={d.displayName}
                icon={<Icon size={26} />}
                locked={!cloudUnlocked}
                onClick={() => {
                  if (!cloudUnlocked) { onOpenChange(false); openUpgrade(); }
                  else setSelection({ kind: "provider", descriptor: d });
                }}
              />
            );
          })}
          <ProviderTile label="Import a kubeconfig" icon={<Upload size={26} />} onClick={() => setSelection({ kind: "import" })} />
        </div>
      ) : selection.kind === "provider" ? (
        <ConnectWizard descriptor={selection.descriptor} onConnected={() => onOpenChange(false)} />
      ) : (
        <ImportKubeconfigPanel onDone={() => onOpenChange(false)} />
      )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
