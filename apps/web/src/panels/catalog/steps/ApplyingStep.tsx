import { Loader } from "@/components/Loader";

/** Step 5 — Applying. Streaming log output from kubectl/helm. */
export function ApplyingStep({ log }: { log: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader size={16} label="applying" />
        Applying…
      </div>
      <pre className="max-h-72 min-h-24 overflow-auto rounded-md bg-muted/40 p-3 text-xs font-mono whitespace-pre-wrap">
        {log || "running…"}
      </pre>
    </div>
  );
}
