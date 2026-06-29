import { describe, it, expect } from "vitest";
import { connectionStatus } from "./connectionStatus";

describe("connectionStatus", () => {
  it("reports ok when connected with no error", () => {
    expect(connectionStatus(true, null)).toEqual({ label: "kubectl: ok", tone: "ok" });
  });

  it("reports reconnecting when the transport is down, regardless of any stale error", () => {
    // A dropped WebSocket is a transport issue we retry forever, NOT a kubectl
    // failure. It must read as reconnecting even if an old error lingers.
    expect(connectionStatus(false, null)).toEqual({ label: "reconnecting…", tone: "warn" });
    expect(connectionStatus(false, "websocket connection failed")).toEqual({
      label: "reconnecting…",
      tone: "warn",
    });
  });

  it("reports error only when connected but the server reported a watch error", () => {
    expect(connectionStatus(true, "watch failed")).toEqual({ label: "kubectl: error", tone: "error" });
  });
});
