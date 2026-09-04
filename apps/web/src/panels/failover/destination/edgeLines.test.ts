import { describe, expect, it } from "vitest";
import { formatEdgeLines, parseEdgeLines } from "./edgeLines";

describe("parseEdgeLines", () => {
  it("reads one server per line", () => {
    expect(parseEdgeLines("node1 10.0.0.1\nnode2 10.0.0.2")).toEqual([
      { name: "node1", ip: "10.0.0.1" },
      { name: "node2", ip: "10.0.0.2" },
    ]);
  });

  it("tolerates ragged spacing and blank lines", () => {
    expect(parseEdgeLines("  node1   10.0.0.1  \n\n\nnode2\t10.0.0.2\n")).toHaveLength(2);
  });

  it("drops a line that is not a name and an address", () => {
    expect(parseEdgeLines("node1\n10.0.0.2\n\nnode3 10.0.0.3")).toEqual([{ name: "node3", ip: "10.0.0.3" }]);
  });

  it("round-trips", () => {
    const backends = [{ name: "node1", ip: "10.0.0.1" }];
    expect(parseEdgeLines(formatEdgeLines(backends))).toEqual(backends);
  });
});
