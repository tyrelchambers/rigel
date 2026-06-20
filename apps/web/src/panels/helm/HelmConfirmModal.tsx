import { Modal } from "@/components/ui/modal";

interface HelmConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The exact helm argv to display, e.g. ["uninstall","web","-n","apps"]. */
  command: string[];
  running: boolean;
  error?: string | null;
  onConfirm: () => void;
}

export function HelmConfirmModal({ open, onOpenChange, title, command, running, error, onConfirm }: HelmConfirmModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <p className="mb-2 text-sm text-muted-foreground">This will run:</p>
      <pre className="mb-4 overflow-x-auto rounded-md bg-black/30 p-3 text-xs">
        {["helm", ...command].join(" ")}
      </pre>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-white/[0.05]" onClick={() => onOpenChange(false)} disabled={running}>
          Cancel
        </button>
        <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50" onClick={onConfirm} disabled={running}>
          {running ? "Running…" : "Run"}
        </button>
      </div>
    </Modal>
  );
}
