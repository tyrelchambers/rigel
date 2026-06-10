import { useState } from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStopForward } from "@/lib/api";
import { formatForwardLabel, type ActiveForward } from "./portForward";

/** Status dot color per forward status. */
function statusDotClass(status: ActiveForward["status"]): string {
  switch (status) {
    case "running":
      return "bg-green-500";
    case "failed":
      return "bg-red-500";
    default:
      return "bg-amber-500";
  }
}

function statusLabel(status: ActiveForward["status"]): string {
  switch (status) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    default:
      return "starting…";
  }
}

/**
 * One active-forward row (docs/parity/portforward.md §"List Items"): status dot,
 * target label, namespace, a clickable/copyable 127.0.0.1:<localPort> when
 * running, a red Stop button, and the first line of the error when failed.
 */
export function ForwardRow({ forward }: { forward: ActiveForward }) {
  const stop = useStopForward();
  const [copied, setCopied] = useState(false);

  const url = `http://127.0.0.1:${forward.localPort}`;
  const hostPort = `127.0.0.1:${forward.localPort}`;

  function copy() {
    void navigator.clipboard?.writeText(hostPort).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <li className="flex items-center gap-3 rounded-md border bg-background px-3 py-2 text-sm">
      <span
        className={`size-2 shrink-0 rounded-full ${statusDotClass(forward.status)}`}
        aria-label={statusLabel(forward.status)}
        title={statusLabel(forward.status)}
      />

      <span className="font-mono">{formatForwardLabel(forward)}</span>
      <span className="font-mono text-xs text-muted-foreground/70">{forward.namespace}</span>

      {forward.status === "running" && (
        <span className="flex items-center gap-1">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 font-mono text-primary hover:underline"
          >
            {hostPort}
            <ExternalLink className="size-3" />
          </a>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={copy}
            aria-label="Copy local address"
            title="Copy"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </Button>
        </span>
      )}

      {forward.status === "failed" && forward.failureMessage && (
        <span className="truncate text-xs text-destructive" title={forward.failureMessage}>
          {forward.failureMessage}
        </span>
      )}

      <Button
        variant="destructive"
        size="xs"
        className="ml-auto"
        onClick={() => stop.mutate(forward.id)}
        disabled={stop.isPending}
      >
        Stop
      </Button>
    </li>
  );
}
