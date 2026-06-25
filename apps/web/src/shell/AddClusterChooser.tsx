import { Boxes, Cloud, PlusCircle } from "lucide-react";
import { Modal } from "@/components/ui/modal";

function ChoiceRow({
  icon, title, subtitle, onClick,
}: { icon: React.ReactNode; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={title}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, cursor: "pointer",
        textAlign: "left", background: "var(--surface-primary)", border: "1px solid var(--border-strong)", color: "var(--fg-primary)",
      }}
    >
      <span style={{ color: "var(--accent-soft)" }}>{icon}</span>
      <span style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--fg-secondary)" }}>{subtitle}</span>
      </span>
    </button>
  );
}

export function AddClusterChooser({
  open, onOpenChange, onCreateLocal, onConnectExisting,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreateLocal: () => void;
  onConnectExisting: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Add a cluster" icon={<PlusCircle className="size-[17px]" />} maxWidth="!max-w-md">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <ChoiceRow icon={<Boxes size={20} />} title="Create a local cluster" subtitle="Spin up kind or k3d on this machine" onClick={onCreateLocal} />
        <ChoiceRow icon={<Cloud size={20} />} title="Connect to an existing cluster" subtitle="DigitalOcean, or import a kubeconfig" onClick={onConnectExisting} />
      </div>
    </Modal>
  );
}
