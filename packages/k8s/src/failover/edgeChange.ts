export const EDGE_HOST = "159.203.36.138";

export const HOME_BACKEND_NODES = [
  { name: "node1", ip: "100.96.213.121" },
  { name: "node2", ip: "100.99.155.125" },
  { name: "node3", ip: "100.81.189.44" },
] as const;

export interface EdgeChange {
  host: string;
  backends: Array<"http_backend" | "https_backend">;
  replaceWith: string;
  snippet: string;
  revertSnippet: string;
}

function serverLines(ip: string): { http: string; https: string } {
  return {
    http: HOME_BACKEND_NODES.map((n) => `    server ${n.name} ${ip}:80 check`).join("\n"),
    https: HOME_BACKEND_NODES.map((n) => `    server ${n.name} ${ip}:443 check`).join("\n"),
  };
}

function homeLines(): { http: string; https: string } {
  return {
    http: HOME_BACKEND_NODES.map((n) => `    server ${n.name} ${n.ip}:80 check`).join("\n"),
    https: HOME_BACKEND_NODES.map((n) => `    server ${n.name} ${n.ip}:443 check`).join("\n"),
  };
}

/** Copy-pasteable haproxy edit for the edge VPS. Routing is a single default
 *  backend, so every domain moves together. */
export function edgeChangeFor(loadBalancerIp: string): EdgeChange {
  const cutover = serverLines(loadBalancerIp);
  const home = homeLines();
  const snippet = [
    `# ssh root@${EDGE_HOST}`,
    `# replace the three server lines in both backends`,
    `backend http_backend`,
    cutover.http,
    `backend https_backend`,
    cutover.https,
  ].join("\n");
  const revertSnippet = [
    `# ssh root@${EDGE_HOST}`,
    `backend http_backend`,
    home.http,
    `backend https_backend`,
    home.https,
  ].join("\n");
  return {
    host: EDGE_HOST,
    backends: ["http_backend", "https_backend"],
    replaceWith: loadBalancerIp,
    snippet,
    revertSnippet,
  };
}
