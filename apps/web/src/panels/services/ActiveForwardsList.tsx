import { useState } from "react";
import { ChevronRight, ChevronDown, TriangleAlert } from "lucide-react";
import { ForwardRow } from "./ForwardRow";
import type { ActiveForward } from "./portForward";

/**
 * Collapsible "ACTIVE FORWARDS (n)" section above the services table
 * (docs/parity/portforward.md §"Active Forwards List"). Renders nothing when
 * there are no forwards. Carries the containerized-loopback caveat in its header.
 */
export function ActiveForwardsList({ forwards }: { forwards: ActiveForward[] }) {
  const [open, setOpen] = useState(true);
  if (forwards.length === 0) return null;

  return (
    <section className="rounded-md border bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Active forwards ({forwards.length})
        </span>
      </button>

      {open && (
        <div className="space-y-2 px-3 pb-3">
          <p className="flex gap-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Port forwarding runs inside the server container. 127.0.0.1:&lt;port&gt; is reachable
              from your machine only when running the server locally or when the port is published.
            </span>
          </p>
          <ul className="space-y-1.5">
            {forwards.map((f) => (
              <ForwardRow key={f.id} forward={f} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
