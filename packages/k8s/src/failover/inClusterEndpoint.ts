const CLUSTER_LOCAL = /\.svc\.cluster\.local(?:[/:?]|$)/i;
const TAILNET = /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/;

/** True when a barman/S3 endpoint never leaves the source cluster. */
export function endpointIsInsideSourceCluster(endpoint: string): boolean {
  const e = endpoint.trim();
  if (!e) return false;
  if (CLUSTER_LOCAL.test(e)) return true;
  if (/^https?:\/\/garage(\.|$)/i.test(e)) return true;
  return TAILNET.test(e);
}

export function containsTailnetAddress(value: string): boolean {
  return TAILNET.test(value);
}

export function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) walkStrings(item, visit);
}
