import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { importKubeconfig as defaultImport } from "@/lib/api";
import { toast } from "sonner";

export function ImportKubeconfigPanel({
  onImport = defaultImport,
  onDone,
}: {
  onImport?: (kubeconfig: string) => Promise<{ ok: boolean; added?: string[]; backupPath?: string | null }>;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await onImport(text.trim());
      qc.invalidateQueries({ queryKey: ["contexts"] });
      toast.success(
        `Imported ${r.added?.length ?? 0} context${r.added?.length === 1 ? "" : "s"}`,
        { description: r.backupPath ? `Kubeconfig backed up to ${r.backupPath}` : undefined },
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label htmlFor="kubeconfig-text" style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
        Paste a kubeconfig
      </label>
      <textarea
        id="kubeconfig-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={10}
        style={{
          fontFamily: "var(--font-mono, monospace)", fontSize: 12, padding: 8, borderRadius: 8,
          background: "var(--surface-primary)", color: "var(--fg-primary)",
          border: "1px solid var(--border-strong)", resize: "vertical",
        }}
      />
      {error ? <div style={{ color: "var(--destructive)", fontSize: 12 }}>{error}</div> : null}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button disabled={!text.trim() || busy} onClick={submit}>
          {busy ? "Importing…" : "Import"}
        </Button>
      </div>
    </div>
  );
}
