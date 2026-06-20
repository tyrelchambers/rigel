// apps/web/src/lib/agents.test.ts
import { describe, it, expect } from "vitest";
import { connectionLabel } from "./api";

describe("connectionLabel", () => {
  it("maps connection states to display labels", () => {
    expect(connectionLabel("connected")).toBe("Connected");
    expect(connectionLabel("notConnected")).toBe("Not connected");
    expect(connectionLabel("comingSoon")).toBe("Coming soon");
  });
});
