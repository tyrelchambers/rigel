import type { FailoverEdgeView } from "@/lib/api";

/** One "name address" per line. A line that is not both is not a server. */
export function parseEdgeLines(text: string): FailoverEdgeView["backends"] {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .flatMap(([name, ip]) => (name && ip ? [{ name, ip }] : []));
}

export function formatEdgeLines(backends: FailoverEdgeView["backends"]): string {
  return backends.map((b) => `${b.name} ${b.ip}`).join("\n");
}
