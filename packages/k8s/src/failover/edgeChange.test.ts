import { describe, expect, it } from "vitest";
import { edgeChangeFor } from "./edgeChange";

const edge = {
  host: "203.0.113.9",
  backends: [
    { name: "node1", ip: "10.0.0.1" },
    { name: "node2", ip: "10.0.0.2" },
  ],
};

describe("edgeChangeFor", () => {
  it("rewrites every server line onto the load balancer, both ports", () => {
    const change = edgeChangeFor("198.51.100.5", edge);
    expect(change.configured).toBe(true);
    expect(change.host).toBe("203.0.113.9");
    expect(change.snippet).toContain("ssh root@203.0.113.9");
    expect(change.snippet).toContain("server node1 198.51.100.5:80 check");
    expect(change.snippet).toContain("server node2 198.51.100.5:443 check");
  });

  it("reverts to the home addresses", () => {
    const change = edgeChangeFor("198.51.100.5", edge);
    expect(change.revertSnippet).toContain("server node1 10.0.0.1:80 check");
    expect(change.revertSnippet).toContain("server node2 10.0.0.2:443 check");
    expect(change.revertSnippet).not.toContain("198.51.100.5");
  });

  it("invents no edge when none is configured", () => {
    const change = edgeChangeFor("198.51.100.5");
    expect(change.configured).toBe(false);
    expect(change.host).toBe("");
    expect(change.snippet).toContain("198.51.100.5");
    expect(change.snippet).toContain("No edge is configured");
    expect(change.snippet).not.toContain("ssh root@");
  });

  it("treats an edge with no backends as unconfigured", () => {
    const change = edgeChangeFor("198.51.100.5", { host: "203.0.113.9", backends: [] });
    expect(change.configured).toBe(false);
  });
});
