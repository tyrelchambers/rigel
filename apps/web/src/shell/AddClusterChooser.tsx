import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBoxesStacked, faCloud, faCirclePlus } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";

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
        <span className="text-sm" style={{ fontWeight: 600 }}>{title}</span>
        <span className="text-xs" style={{ color: "var(--fg-secondary)" }}>{subtitle}</span>
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon>
            <FontAwesomeIcon icon={faCirclePlus} className="size-[17px]" />
          </DialogIcon>
          <DialogTitle>Add a cluster</DialogTitle>
        </DialogHeader>
        <DialogBody>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <ChoiceRow icon={<FontAwesomeIcon icon={faBoxesStacked} className="size-[20px]" />} title="Create a local cluster" subtitle="Spin up kind or k3d on this machine" onClick={onCreateLocal} />
        <ChoiceRow icon={<FontAwesomeIcon icon={faCloud} className="size-[20px]" />} title="Connect to an existing cluster" subtitle="DigitalOcean, or import a kubeconfig" onClick={onConnectExisting} />
      </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
