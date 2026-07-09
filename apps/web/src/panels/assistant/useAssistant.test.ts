import { describe, it, expect } from "vitest";
import { pickAgentContainer } from "./useAssistant";

describe("pickAgentContainer", () => {
  it("prefers the container named 'agent'", () => {
    expect(
      pickAgentContainer([
        { name: "sidecar", image: "busybox:1" },
        { name: "agent", image: "ghcr.io/x/rigel-assistant:0.1.415" },
      ]),
    ).toEqual({ image: "ghcr.io/x/rigel-assistant:0.1.415", container: "agent" });
  });

  it("falls back to the first container when none is named 'agent'", () => {
    expect(pickAgentContainer([{ name: "app", image: "ghcr.io/x/y:1" }])).toEqual({
      image: "ghcr.io/x/y:1",
      container: "app",
    });
  });

  it("returns null when there is no usable container", () => {
    expect(pickAgentContainer([])).toBeNull();
    expect(pickAgentContainer(undefined)).toBeNull();
    expect(pickAgentContainer([{ name: "agent" }])).toBeNull();
  });
});
