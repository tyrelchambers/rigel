import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useClusterTools } from "@/lib/api";
import { sendClusterCreate, sendClusterStop, onClusterEvent } from "@/lib/ws";

const VERSIONS = [
  { id: "default", label: "Latest" },
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

const INPUT_CLASS =
  "w-full rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground " +
  "outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 " +
  "disabled:cursor-not-allowed disabled:opacity-50";
const LABEL_CLASS = "mb-1.5 block text-xs font-medium text-muted-foreground";

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
    if (open) { setName(""); setVersion("default"); setTool("kind"); setCreating(false); setLines([]); setError(null); }
  }, [open]);

  // Default to kind, but if only k3d is installed prefer it. Runs after the reset
  // above (which restores kind) so reopening always starts from a clean default.
  useEffect(() => {
    if (open && tools && !tools.kind && tools.k3d) setTool("k3d");
  }, [open, tools]);

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
  const hasTool = !!tools && (tools.kind || tools.k3d);
  const ready = dockerOk && hasTool;
  const nameErr = nameError(name);
  const canCreate = ready && !nameErr && !creating;

  function start() {
    setError(null); setLines([]); setCreating(true);
    sendClusterCreate({ tool, name, version });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => { if (!o && creating) sendClusterStop(); onOpenChange(o); }}
      title="Create cluster"
      maxWidth="!max-w-md"
    >
      {!tools ? (
        <p className="text-sm text-muted-foreground">Checking your environment…</p>
      ) : !ready ? (
        // ── Setup state: explain what's needed and how to get it ──────────────
        <div className="flex flex-col gap-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Rigel creates a local cluster by running it inside Docker with{" "}
            <span className="font-medium text-foreground">kind</span> or{" "}
            <span className="font-medium text-foreground">k3d</span>. These are small command-line
            tools that spin up a throwaway Kubernetes cluster on your machine. You need one of them
            installed, plus Docker running.
          </p>

          {/* Step 1: install a tool (only when neither is present) */}
          {!tools.kind && !tools.k3d && (
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">Install a tool (kind is the simplest)</div>
              <div className="flex items-center gap-2 rounded-md border bg-muted/30 py-2 pr-2 pl-3">
                <code className="flex-1 font-mono text-sm text-foreground">brew install kind</code>
                <Button variant="ghost" size="sm" onClick={() => navigator.clipboard?.writeText("brew install kind")}>
                  <Copy className="size-3.5" /> Copy
                </Button>
              </div>
            </div>
          )}

          {/* Status checklist */}
          <div className="flex flex-col gap-2">
            <StatusRow ok={tools.kind || tools.k3d} okText="kind or k3d installed" badText="No cluster tool found" />
            <StatusRow ok={dockerOk} okText="Docker is running" badText="Docker is not running" />
          </div>

          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "Checking…" : "Re-check"}
            </Button>
            <span className="text-xs text-muted-foreground">Run the steps above, then re-check.</span>
          </div>
        </div>
      ) : (
        // ── Form state: ready to create ───────────────────────────────────────
        <div className="flex flex-col gap-5">
          <div>
            <label htmlFor="cc-name" className={LABEL_CLASS}>Name</label>
            <input
              id="cc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="dev"
              disabled={creating}
              autoComplete="off"
              spellCheck={false}
              className={INPUT_CLASS}
            />
            {name && nameErr && <p className="mt-1.5 text-xs text-destructive">{nameErr}</p>}
          </div>

          <div className="flex flex-wrap items-end gap-6">
            {/* Tool choice only matters when both are installed. */}
            {tools.kind && tools.k3d && (
              <div>
                <span className={LABEL_CLASS}>Tool</span>
                <div className="flex gap-2">
                  <Button variant={tool === "kind" ? "default" : "outline"} size="sm" disabled={creating} onClick={() => setTool("kind")}>kind</Button>
                  <Button variant={tool === "k3d" ? "default" : "outline"} size="sm" disabled={creating} onClick={() => setTool("k3d")}>k3d</Button>
                </div>
              </div>
            )}
            <div>
              <label htmlFor="cc-version" className={LABEL_CLASS}>Kubernetes version</label>
              <select
                id="cc-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                disabled={creating}
                className={INPUT_CLASS + " cursor-pointer"}
              >
                {VERSIONS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
          </div>

          {(lines.length > 0 || error) && (
            <pre
              ref={logRef}
              className="max-h-52 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
            >
              {lines.join("\n")}
              {error ? `\n✗ ${error}` : ""}
            </pre>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Creates a throwaway cluster with {tools.kind && tools.k3d ? tool : tools.kind ? "kind" : "k3d"}.
            </span>
            <Button onClick={start} disabled={!canCreate}>
              {creating ? "Creating…" : "Create cluster"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function StatusRow({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? <Check className="size-4 text-emerald-500" /> : <X className="size-4 text-muted-foreground" />}
      <span className={ok ? "text-foreground" : "text-muted-foreground"}>{ok ? okText : badText}</span>
    </div>
  );
}
