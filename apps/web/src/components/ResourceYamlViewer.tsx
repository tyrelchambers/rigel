// ResourceYamlViewer — read-only YAML view of a cluster resource. Mounted once
// at the app root; opens whenever `viewYaml(...)` is called (from any context
// menu). Fetches the canonical YAML via GET /api/resource (kubectl get -o yaml).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, FileCode } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useYamlViewer } from "@/store/yamlViewer";

async function fetchResourceYaml(kind: string, name: string, namespace?: string): Promise<string> {
  const params = new URLSearchParams({ kind, name });
  if (namespace) params.set("namespace", namespace);
  const res = await fetch(`/api/resource?${params.toString()}`);
  const data = (await res.json().catch(() => ({}))) as { code?: number; yaml?: string; stderr?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  if (data.code !== 0) throw new Error(data.stderr || "kubectl get failed");
  return data.yaml ?? "";
}

export function ResourceYamlViewer() {
  const target = useYamlViewer((s) => s.target);
  const close = useYamlViewer((s) => s.close);
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["resource-yaml", target?.kind, target?.name, target?.namespace],
    queryFn: () => fetchResourceYaml(target!.kind, target!.name, target!.namespace),
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

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader className="flex-row items-start gap-3">
          <FileCode className="mt-0.5 size-5 shrink-0" style={{ color: "var(--accent-primary)" }} />
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="truncate font-mono text-[15px]">{title}</DialogTitle>
            <DialogDescription className="text-xs">{subtitle}</DialogDescription>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleCopy} disabled={!data}>
            {copied ? <Check className="size-3.5" style={{ color: "#28C840" }} /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </DialogHeader>

        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
        ) : isError ? (
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-destructive/10 p-3 text-xs font-mono text-destructive whitespace-pre-wrap">
            {error instanceof Error ? error.message : String(error)}
          </pre>
        ) : (
          <pre
            className="max-h-[65vh] overflow-auto rounded-lg p-3 text-xs font-mono leading-5 whitespace-pre"
            style={{ background: "#08080A", border: "1px solid #26272B" }}
          >
            {data}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
