import { CircleArrowUp, Check, CloudOff, Info } from "lucide-react";
import type { UpdateResult } from "@/lib/api";

function Divider() {
  return <span aria-hidden className="h-[22px] w-px shrink-0 bg-[var(--border-strong)]" />;
}

/** Pure render of the agent update indicator. Returns null when there is nothing
 *  to show (no result yet). Trailing divider separates it from the token group. */
export function AgentUpdateView({
  result,
  onUpdate,
}: {
  result: UpdateResult | undefined | null;
  onUpdate: (latest: string) => void;
}) {
  if (!result) return null;

  if (result.updateAvailable && result.latest) {
    const latest = result.latest;
    return (
      <>
        <span className="flex items-center gap-2 whitespace-nowrap rounded-md bg-[var(--accent-dim)] px-2.5 py-1">
          <CircleArrowUp className="size-3.5 shrink-0 text-[var(--accent-primary)]" />
          {result.currentTag && (
            <>
              <span className="font-mono text-xs text-[var(--fg-tertiary)]">{result.currentTag}</span>
              <span aria-hidden className="font-mono text-xs text-[var(--fg-tertiary)]">→</span>
            </>
          )}
          <span className="font-mono text-xs font-semibold text-[var(--accent-primary)]">{latest}</span>
        </span>
        <button
          type="button"
          onClick={() => onUpdate(latest)}
          className="rounded-md bg-[var(--accent-primary)] px-2.5 py-1 text-xs font-semibold text-[var(--fg-inverse)]"
        >
          Update
        </button>
        <Divider />
      </>
    );
  }

  if (result.kind === "unknown") {
    return (
      <>
        <span
          title={result.reason}
          className="flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--fg-tertiary)]"
        >
          <CloudOff className="size-3.5 shrink-0" />
          Couldn't check for updates
          <Info className="size-3 shrink-0" />
        </span>
        <Divider />
      </>
    );
  }

  return (
    <>
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--fg-tertiary)]">
        <Check className="size-3.5 shrink-0 text-[var(--status-running)]" />
        Up to date
        {result.currentTag && <span className="font-mono">{result.currentTag}</span>}
      </span>
      <Divider />
    </>
  );
}
