import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, LoaderCircle, Hourglass } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { Button } from "@/components/ui/button";
import type { Pod } from "../../pods/types";
import { matchInstancePods, podReadiness } from "../wizardLogic";

const POLL_MS = 1500;
const SOFT_TIMEOUT_MS = 5 * 60 * 1000;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 3;

/**
 * Step 6 — Verifying. Polls the live cache for pods labeled
 * app.kubernetes.io/instance=instance in the namespace every 1.5s. Advances to
 * Done when all matched pods are Ready; hands off to chat on trouble.
 * (docs/parity/catalog.md §"Step 6: Verifying")
 */
export function VerifyingStep({
  instance,
  namespace,
  onDone,
  onHandoff,
}: {
  instance: string;
  namespace: string;
  onDone: () => void;
  onHandoff: (reason: string) => void;
}) {
  const resources = useCluster((s) => s.resources);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(Date.now());

  // 1.5s ticker drives re-evaluation of the live cache.
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startedAt.current), POLL_MS);
    return () => clearInterval(id);
  }, []);

  const pods = Object.values((resources["pods"] ?? {}) as Record<string, Pod>);
  const matched = matchInstancePods(pods, namespace, instance);
  const readiness = podReadiness(matched);

  // Advance / hand off based on readiness + timeouts.
  useEffect(() => {
    if (readiness.state === "ready") {
      onDone();
    } else if (
      readiness.state === "failed" ||
      readiness.maxRestarts >= MAX_RESTARTS ||
      elapsed >= HARD_TIMEOUT_MS
    ) {
      onHandoff(
        readiness.state === "failed"
          ? "A pod failed to start"
          : readiness.maxRestarts >= MAX_RESTARTS
            ? "A pod is crash-looping"
            : "Verification timed out",
      );
    }
  }, [readiness.state, readiness.maxRestarts, elapsed, onDone, onHandoff]);

  const overSoft = elapsed >= SOFT_TIMEOUT_MS;

  const rows: Array<{ label: string; icon: "done" | "wait" | "spin" | "fail"; detail?: string }> = [
    { label: "Manifest applied", icon: "done" },
    {
      label: "Pods",
      icon:
        readiness.state === "ready"
          ? "done"
          : readiness.state === "failed"
            ? "fail"
            : readiness.total === 0
              ? "spin"
              : "spin",
      detail:
        readiness.total === 0
          ? "creating…"
          : `${readiness.ready}/${readiness.total} ready`,
    },
  ];

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2 text-sm">
            {r.icon === "done" && <Check className="size-4 text-green-600 dark:text-green-400" />}
            {r.icon === "spin" && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
            {r.icon === "wait" && <Hourglass className="size-4 text-muted-foreground" />}
            {r.icon === "fail" && <CircleAlert className="size-4 text-destructive" />}
            <span>{r.label}</span>
            {r.detail && <span className="ml-auto font-mono text-xs text-muted-foreground">{r.detail}</span>}
          </li>
        ))}
      </ul>

      {overSoft && readiness.state !== "ready" && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p>This is taking a while.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onHandoff("Taking a while — handed off to chat")}
          >
            Hand off to chat
          </Button>
        </div>
      )}
    </div>
  );
}
