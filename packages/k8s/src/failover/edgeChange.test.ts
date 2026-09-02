import { describe, expect, it } from "vitest";
import { EDGE_HOST, edgeChangeFor } from "./edgeChange";

describe("edgeChangeFor", () => {
  it("writes both backends to the load balancer IP and keeps a revert to the home nodes", () => {
    const change = edgeChangeFor("203.0.113.10");
    expect(change.host).toBe(EDGE_HOST);
    expect(change.backends).toEqual(["http_backend", "https_backend"]);
    expect(change.replaceWith).toBe("203.0.113.10");
    expect(change.snippet).toContain("server node1 203.0.113.10:80 check");
    expect(change.snippet).toContain("server node1 203.0.113.10:443 check");
    expect(change.revertSnippet).toContain("server node1 100.96.213.121:80 check");
    expect(change.revertSnippet).toContain("server node3 100.81.189.44:443 check");
    expect(change.snippet).not.toContain("100.96.213.121");
  });
});
