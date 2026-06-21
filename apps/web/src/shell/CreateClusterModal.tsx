import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { useClusterTools } from "@/lib/api";
import { sendClusterCreate, sendClusterStop, onClusterEvent } from "@/lib/ws";

// Short labels for the version segmented control ("default" → "Latest").
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
  const toolOk = tool === "kind" ? !!tools?.kind : !!tools?.k3d;
  const nameErr = nameError(name);
  const canCreate = dockerOk && toolOk && !nameErr && !creating;
  const needsSetup = !!tools && (!dockerOk || (!tools.kind && !tools.k3d));

  function start() {
    setError(null); setLines([]); setCreating(true);
    sendClusterCreate({ tool, name, version });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => { if (!o && creating) sendClusterStop(); onOpenChange(o); }}
      title="Create cluster"
      maxWidth="!max-w-lg"
    >
      <div className="flex flex-col gap-5">
        {/* Detect-and-guide: only when a prerequisite is missing. */}
        {needsSetup && (
          <div className="flex flex-col gap-2.5 rounded-lg border bg-muted/30 p-3.5">
            <div className="text-sm font-medium">Set up to create local clusters</div>
            {!tools!.kind && !tools!.k3d && (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>Install a tool:</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">brew install kind</code>
                <Button variant="ghost" size="xs" onClick={() => navigator.clipboard?.writeText("brew install kind")}>
                  Copy
                </Button>
              </div>
            )}
            {!dockerOk && (
              <div className="text-sm text-muted-foreground">Start Docker, then re-check.</div>
            )}
            <Button variant="outline" size="sm" className="self-start" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "Checking…" : "Re-check"}
            </Button>
          </div>
        )}

        {/* Name */}
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

        {/* Tool + version */}
        <div className="flex flex-wrap gap-6">
          <div>
            <span className={LABEL_CLASS}>Tool</span>
            <SegmentedTabs
              tabs={[{ id: "kind", label: "kind" }, { id: "k3d", label: "k3d" }]}
              active={tool}
              onChange={(id) => setTool(id as "kind" | "k3d")}
            />
            {tools && !toolOk && (
              <p className="mt-1.5 text-xs text-muted-foreground">{tool} is not installed.</p>
            )}
          </div>
          <div>
            <span className={LABEL_CLASS}>Kubernetes version</span>
            <SegmentedTabs tabs={VERSIONS} active={version} onChange={setVersion} />
          </div>
        </div>

        {/* Streamed progress */}
        {(lines.length > 0 || error) && (
          <pre
            ref={logRef}
            className="max-h-52 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
          >
            {lines.join("\n")}
            {error ? `\n✗ ${error}` : ""}
          </pre>
        )}

        {/* Footer */}
        <div className="flex justify-end">
          <Button onClick={start} disabled={!canCreate}>
            {creating ? "Creating…" : "Create cluster"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
