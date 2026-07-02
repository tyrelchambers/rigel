// ResourceYamlViewer — YAML view of a cluster resource. Mounted once at the app
// root; opens whenever viewYaml(...) / editYaml(...) is called from any context
// menu. Read-only by default; when the target is `editable`, an Edit button
// switches to a Monaco editor seeded with the CLEANED manifest (status +
// managedFields stripped server-side) and an Apply… button re-applies it through
// the guarded ConfirmSheet (no new mutation path).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, FileCode, Pencil, Play, X } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useClusterYamlSchema } from "@/lib/useClusterYamlSchema";
import { useYamlViewer } from "@/store/yamlViewer";
import { fetchResourceYaml, type ActionBlock } from "@/lib/api";

export function ResourceYamlViewer() {
  const target = useYamlViewer((s) => s.target);
  const close = useYamlViewer((s) => s.close);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [applyAction, setApplyAction] = useState<ActionBlock | null>(null);
  const { data: schema } = useClusterYamlSchema();

  // Reset transient edit state whenever the target changes (incl. any pending
  // apply action, so a stale manifest can't carry over to a new resource).
  useEffect(() => { setEditing(false); setDraft(""); setApplyAction(null); }, [target?.kind, target?.name, target?.namespace]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["resource-yaml", target?.kind, target?.name, target?.namespace, target?.editable],
    // Editable targets fetch the CLEANED manifest (ready to re-apply).
    queryFn: () => fetchResourceYaml(target!.kind, target!.name, target!.namespace, target!.editable),
    enabled: !!target,
  });

  if (!target) return null;
  const title = target.title ?? `${target.kind}/${target.name}`;
  const subtitle = target.namespace ? `namespace: ${target.namespace}` : "cluster-scoped";

  function handleCopy() {
    if (!data) return;
    void navigator.clipboard.writeText(data).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function startEdit() {
    setDraft(data ?? "");
    setEditing(true);
  }

  function handleApply() {
    setApplyAction({ kind: "applyManifest", label: `Apply ${title}`, manifest: draft });
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent showCloseButton={false} className="max-w-4xl">
          <DialogHeader className="flex-row items-center gap-3">
            <FileCode className="size-5 shrink-0" style={{ color: "var(--accent-primary)" }} />
            <div className="flex min-w-0 flex-1 flex-col">
              <DialogTitle className="truncate font-mono text-[15px]">{title}</DialogTitle>
              <DialogDescription className="text-xs">
                {subtitle}{editing ? " · editing" : ""}
              </DialogDescription>
            </div>
            {target.editable && !editing && data && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={startEdit}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            )}
            {editing ? (
              <Button size="sm" className="gap-1.5" onClick={handleApply} disabled={draft.trim() === ""}>
                <Play className="size-3.5 fill-current" /> Apply…
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handleCopy} disabled={!data}>
                {copied ? <Check className="size-3.5" style={{ color: "#28C840" }} /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" onClick={close} aria-label="Close">
              <X className="size-4" />
            </Button>
          </DialogHeader>

          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : isError ? (
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-destructive/10 p-3 text-xs font-mono text-destructive whitespace-pre-wrap">
              {error instanceof Error ? error.message : String(error)}
            </pre>
          ) : (
            <div style={{ height: "65vh", borderRadius: 8, overflow: "hidden", border: "1px solid #26272B" }}>
              {/* Edit mode is schema-aware; read-only view is syntax-highlight only
                  (no validation squiggles on a manifest you can't edit). */}
              <YamlEditor
                value={editing ? draft : (data ?? "")}
                onChange={editing ? setDraft : undefined}
                readOnly={!editing}
                schema={editing ? (schema ?? null) : null}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmSheet action={applyAction} open={!!applyAction} onClose={() => setApplyAction(null)} />
    </>
  );
}
