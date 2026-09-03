import type { FailoverEdge } from "./types";

export interface EdgeChange {
  /** Empty when no edge is configured. */
  host: string;
  configured: boolean;
  backends: string[];
  replaceWith: string;
  snippet: string;
  revertSnippet: string;
}

function serverLines(backends: FailoverEdge["backends"], ip: string, port: number): string {
  return backends.map((b) => `    server ${b.name} ${ip}:${port} check`).join("\n");
}

function homeLines(backends: FailoverEdge["backends"], port: number): string {
  return backends.map((b) => `    server ${b.name} ${b.ip}:${port} check`).join("\n");
}

/**
 * The copy-pasteable edit for whatever fronts the cluster. There is no default
 * edge: a snippet naming someone else's proxy would be worse than none, so an
 * unconfigured edge gets the address and the instruction instead.
 */
export function edgeChangeFor(loadBalancerAddress: string, edge?: FailoverEdge): EdgeChange {
  if (!edge || edge.backends.length === 0) {
    return {
      host: edge?.host ?? "",
      configured: false,
      backends: [],
      replaceWith: loadBalancerAddress,
      snippet: [
        `# No edge is configured in Settings, so this is the address, not the edit.`,
        `# Point whatever fronts your cluster at:`,
        `#   ${loadBalancerAddress}`,
        `# Every domain that resolves to your edge moves together.`,
      ].join("\n"),
      revertSnippet: `# Point your edge back at the home cluster.`,
    };
  }

  const snippet = [
    `# ssh root@${edge.host}`,
    `# replace the server lines in both backends`,
    `backend http_backend`,
    serverLines(edge.backends, loadBalancerAddress, 80),
    `backend https_backend`,
    serverLines(edge.backends, loadBalancerAddress, 443),
  ].join("\n");

  const revertSnippet = [
    `# ssh root@${edge.host}`,
    `backend http_backend`,
    homeLines(edge.backends, 80),
    `backend https_backend`,
    homeLines(edge.backends, 443),
  ].join("\n");

  return {
    host: edge.host,
    configured: true,
    backends: ["http_backend", "https_backend"],
    replaceWith: loadBalancerAddress,
    snippet,
    revertSnippet,
  };
}
