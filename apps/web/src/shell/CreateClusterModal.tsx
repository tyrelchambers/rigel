import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Boxes, Check, CircleCheck, CircleX, Copy, RefreshCw } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useClusterTools } from "@/lib/api";
import { sendClusterCreate, sendClusterStop, onClusterEvent } from "@/lib/ws";
import { toast } from "sonner";

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
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (open) { setName(""); setVersion("default"); setTool("kind"); setCreating(false); setLines([]); setError(null); setCopied(false); }
  }, [open]);

  // Brief "Copied" confirmation on the install command, then revert.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

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
        toast.success(`Cluster "${e.context ?? name}" created`, {
          description: e.backupPath
            ? `Kubeconfig backed up to ${e.backupPath}`
            : "Your kubeconfig couldn't be backed up.",
        });
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

  function copyInstall() {
    navigator.clipboard?.writeText("brew install kind");
    setCopied(true);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => { if (!o && creating) sendClusterStop(); onOpenChange(o); }}
      title="Create cluster"
      icon={<Boxes className="size-[17px]" />}
      maxWidth="!max-w-md"
    >
      {!tools ? (
        <p className="text-sm text-muted-foreground">Checking your environment…</p>
      ) : !ready ? (
        // ── Setup state: explain what's needed and how to get it ──────────────
        <div className="flex flex-col gap-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            This runs a real Kubernetes cluster on your own machine inside Docker, using{" "}
            <span className="font-medium text-foreground">kind</span> or{" "}
            <span className="font-medium text-foreground">k3d</span>. Once it's up, you can deploy to
            it and manage it from Rigel like any other cluster. You just need one of them installed,
            plus Docker running.
          </p>

          {/* Step 1: install a tool (only when neither is present) */}
          {!tools.kind && !tools.k3d && (
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">Install a tool (kind is the simplest)</div>
              <div className="flex items-center justify-between overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#161619] pl-4">
                <code className="flex items-center gap-2.5 py-3.5 font-mono text-[13px]">
                  <span className="text-[#5E6168]">$</span>
                  <span className="text-[#D6D6DC]">brew install kind</span>
                </code>
                <button
                  type="button"
                  onClick={copyInstall}
                  className="flex items-center gap-1.5 self-stretch border-l border-white/[0.08] px-4 text-[13px] font-semibold text-[#4FB0F2] transition-colors hover:bg-white/[0.03]"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          {/* Status checks */}
          <div className="flex flex-col divide-y divide-white/[0.04] overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#141417]">
            <StatusRow
              ok={tools.kind || tools.k3d}
              okText="kind or k3d installed"
              badText="No cluster tool found"
              badStatus="Not found"
            />
            <StatusRow
              ok={dockerOk}
              okText="Docker is running"
              badText="Docker is not running"
              badStatus="Not running"
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="bg-white/[0.08] text-white hover:bg-white/[0.12]"
            >
              <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
              {isFetching ? "Checking…" : "Re-check"}
            </Button>
            <span className="text-xs text-muted-foreground">Run the steps above, then re-check.</span>
          </div>
        </div>
      ) : (
        // ── Form state: ready to create ───────────────────────────────────────
        <div className="flex flex-col gap-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            kind and k3d run the cluster as Docker containers on this machine. It shows up in Rigel once it's ready.
          </p>

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

          {(creating || lines.length > 0 || error) && (
            <div className="flex flex-col gap-2">
              {creating && (
                <p className="text-xs text-muted-foreground">
                  Creating the cluster inside Docker. This usually takes under a minute.
                </p>
              )}
              {(lines.length > 0 || error) && (
                <pre
                  ref={logRef}
                  className="max-h-52 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
                >
                  {lines.join("\n")}
                  {error ? `\n✗ ${error}` : ""}
                </pre>
              )}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Creates a local cluster with {tools.kind && tools.k3d ? tool : tools.kind ? "kind" : "k3d"}.
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

function StatusRow({
  ok,
  okText,
  badText,
  badStatus,
}: {
  ok: boolean;
  okText: string;
  badText: string;
  badStatus: string;
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-3">
      {ok ? (
        <CircleCheck className="size-[17px] shrink-0 text-[#34D07F]" />
      ) : (
        <CircleX className="size-[17px] shrink-0 text-[#FF6B6B]" />
      )}
      <span className={cn("text-sm font-medium", ok ? "text-foreground" : "text-zinc-300")}>
        {ok ? okText : badText}
      </span>
      <span className="ml-auto text-xs font-medium text-muted-foreground">{ok ? "OK" : badStatus}</span>
    </div>
  );
}
