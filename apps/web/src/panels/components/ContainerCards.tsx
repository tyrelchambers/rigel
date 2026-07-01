import { type ReactNode } from "react";
import { Box, Cpu, MemoryStick } from "lucide-react";

/** Minimal shape of a k8s container as it appears in a raw pod template spec. */
export interface RawContainer {
  name: string;
  image?: string;
  ports?: { containerPort?: number }[];
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}

/** Summary of a single container for the expanded SPEC block. */
export interface ContainerSummary {
  name: string;
  image: string;
  ports: number[];
  cpuReq?: string;
  cpuLim?: string;
  memReq?: string;
  memLim?: string;
}

/** Map raw containers (from any workload's pod template) to display summaries. */
export function summarizeContainers(containers: RawContainer[] | undefined): ContainerSummary[] {
  return (containers ?? []).map((c) => ({
    name: c.name,
    image: c.image ?? "—",
    ports: (c.ports ?? []).map((p) => p.containerPort).filter((n): n is number => typeof n === "number"),
    cpuReq: c.resources?.requests?.cpu,
    cpuLim: c.resources?.limits?.cpu,
    memReq: c.resources?.requests?.memory,
    memLim: c.resources?.limits?.memory,
  }));
}

/** The per-container cards shown in a resource detail's SPEC block. */
export function ContainerCards({ containers }: { containers: ContainerSummary[] }) {
  if (containers.length === 0) return null;
  return (
    <div className="space-y-2">
      {containers.map((c) => (
        <div
          key={c.name}
          className="overflow-hidden rounded-md text-xs"
          style={{ background: "var(--surface-sunken)", border: "1px solid #26272B" }}
        >
          {/* Header strip: container name + ports */}
          <div
            className="flex items-center gap-2 px-2.5 py-1.5"
            style={{ background: "#101014", borderBottom: "1px solid #26272B" }}
          >
            <Box className="size-3 shrink-0 text-muted-foreground" />
            <span className="font-mono font-medium text-primary">{c.name}</span>
            {c.ports.length > 0 && (
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {c.ports.map((p) => `:${p}`).join(" ")}
              </span>
            )}
          </div>
          {/* Body: image + resource cells */}
          <div className="space-y-2 px-2.5 py-2">
            <div className="font-mono text-[11px] text-muted-foreground break-all">{c.image}</div>
            <div className="grid grid-cols-2 gap-1.5">
              <ResourceCell icon={<Cpu className="size-3 shrink-0 text-muted-foreground" />} label="CPU" req={c.cpuReq} lim={c.cpuLim} />
              <ResourceCell icon={<MemoryStick className="size-3 shrink-0 text-muted-foreground" />} label="MEM" req={c.memReq} lim={c.memLim} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A request/limit cell — icon + uppercase label, then `req → lim` in mono. */
function ResourceCell({
  icon,
  label,
  req,
  lim,
}: {
  icon: ReactNode;
  label: string;
  req?: string | null;
  lim?: string | null;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded px-2 py-1"
      style={{ background: "var(--surface-sunken)", border: "1px solid #26272B" }}
    >
      {icon}
      <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{label}</span>
      <span className="ml-auto font-mono text-[11px] text-foreground/90 tabular-nums">
        {req ?? "—"} <span className="text-muted-foreground">→</span> {lim ?? "—"}
      </span>
    </div>
  );
}
