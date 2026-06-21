import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/ui/modal";
import { useClusterTools } from "@/lib/api";
import { sendClusterCreate, sendClusterStop, onClusterEvent } from "@/lib/ws";

const VERSIONS = [
  { id: "default", label: "Default (latest)" },
  { id: "v1.31", label: "v1.31" },
  { id: "v1.30", label: "v1.30" },
  { id: "v1.29", label: "v1.29" },
];

// Mirrors the server validateClusterName rule (apps/server/src/clusterCreate.ts).
function nameError(name: string): string | null {
  if (!name) return "Enter a cluster name.";
  if (name.length > 50) return "Name is too long (50 max).";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) return "Lowercase letters, digits, dashes only.";
  return null;
}

export function CreateClusterModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: tools, refetch, isFetching } = useClusterTools();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [tool, setTool] = useState<"kind" | "k3d">("kind");
  const [version, setVersion] = useState("default");
  const [creating, setCreating] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (open) { setName(""); setVersion("default"); setCreating(false); setLines([]); setError(null); }
  }, [open]);

  useEffect(() => {
    if (tools && !tools.kind && tools.k3d) setTool("k3d");
  }, [tools]);

  useEffect(() => {
    if (!creating) return;
    const off = onClusterEvent((e) => {
      if (e.type === "cluster.progress" && e.line) setLines((p) => [...p, e.line!]);
      else if (e.type === "cluster.error") { setError(e.message ?? "create failed"); setCreating(false); }
      else if (e.type === "cluster.done") {
        qc.invalidateQueries({ queryKey: ["contexts"] });
        setCreating(false);
        onOpenChange(false);
      }
    });
    return off;
  }, [creating, qc, onOpenChange]);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [lines]);

  const dockerOk = !!tools?.dockerRunning;
  const toolOk = tool === "kind" ? !!tools?.kind : !!tools?.k3d;
  const nameErr = nameError(name);
  const canCreate = dockerOk && toolOk && !nameErr && !creating;

  const hint = (label: string, cmd: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-secondary)" }}>
      <span>{label}</span>
      <code style={{ background: "var(--surface-primary)", padding: "2px 6px", borderRadius: 6 }}>{cmd}</code>
      <button type="button" onClick={() => navigator.clipboard?.writeText(cmd)} style={{ cursor: "pointer", fontSize: 11 }}>copy</button>
    </div>
  );

  function start() {
    setError(null); setLines([]); setCreating(true);
    sendClusterCreate({ tool, name, version });
  }

  return (
    <Modal open={open} onOpenChange={(o) => { if (!o && creating) sendClusterStop(); onOpenChange(o); }} title="Create cluster">
      {tools && (!dockerOk || (!tools.kind && !tools.k3d)) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14, padding: 12, borderRadius: 8, background: "var(--surface-primary)", border: "1px solid var(--border-subtle)" }}>
          {!tools.kind && !tools.k3d && hint("Install a tool:", "brew install kind")}
          {!dockerOk && hint("Start Docker:", "open -a Docker")}
          <button type="button" onClick={() => refetch()} disabled={isFetching} style={{ alignSelf: "flex-start", fontSize: 12, cursor: "pointer" }}>
            {isFetching ? "Checking…" : "Re-check"}
          </button>
        </div>
      )}

      <label style={{ display: "block", fontSize: 12, color: "var(--fg-secondary)", marginBottom: 4 }}>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="dev" disabled={creating}
        style={{ width: "100%", marginBottom: 4, padding: "8px 10px", borderRadius: 8, background: "var(--surface-primary)", border: "1px solid var(--border-subtle)", color: "var(--fg-primary)" }} />
      {name && nameErr && <div style={{ color: "var(--accent-soft)", fontSize: 11, marginBottom: 8 }}>{nameErr}</div>}

      <div style={{ display: "flex", gap: 16, margin: "12px 0" }}>
        <div>
          <label style={{ display: "block", fontSize: 12, color: "var(--fg-secondary)", marginBottom: 4 }}>Tool</label>
          <div style={{ display: "flex", gap: 6 }}>
            {(["kind", "k3d"] as const).map((t) => {
              const enabled = t === "kind" ? !!tools?.kind : !!tools?.k3d;
              return (
                <button key={t} type="button" disabled={!enabled || creating} onClick={() => setTool(t)}
                  style={{ padding: "6px 12px", borderRadius: 8, cursor: enabled ? "pointer" : "not-allowed",
                    background: tool === t ? "var(--accent-dim)" : "var(--surface-primary)",
                    border: `1px solid ${tool === t ? "var(--accent-primary)" : "var(--border-subtle)"}`,
                    color: enabled ? "var(--fg-primary)" : "var(--fg-tertiary)" }}>{t}</button>
              );
            })}
          </div>
        </div>
        <div>
          <label style={{ display: "block", fontSize: 12, color: "var(--fg-secondary)", marginBottom: 4 }}>Kubernetes version</label>
          <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={creating}
            style={{ padding: "7px 10px", borderRadius: 8, background: "var(--surface-primary)", border: "1px solid var(--border-subtle)", color: "var(--fg-primary)" }}>
            {VERSIONS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </div>
      </div>

      {(lines.length > 0 || error) && (
        <pre ref={logRef} style={{ maxHeight: 200, overflow: "auto", marginTop: 12, padding: 10, borderRadius: 8, background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", color: "var(--fg-secondary)", fontSize: 11, whiteSpace: "pre-wrap" }}>
          {lines.join("\n")}{error ? `\n✗ ${error}` : ""}
        </pre>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" disabled={!canCreate} onClick={start}
          style={{ padding: "8px 16px", borderRadius: 8, cursor: canCreate ? "pointer" : "not-allowed",
            background: canCreate ? "var(--accent-primary)" : "var(--surface-elevated)",
            color: canCreate ? "var(--fg-inverse)" : "var(--fg-tertiary)", border: "none", fontWeight: 600 }}>
          {creating ? "Creating…" : "Create"}
        </button>
      </div>
    </Modal>
  );
}
