import { test, expect } from "vitest";
import { handleSignal } from "./signal";
import { signalConfigUpdates } from "@rigel/k8s/src/signal";

// sendTest precondition guards are deterministic and run WITHOUT a cluster —
// they short-circuit before any port-forward. The port-forward + bridge HTTP
// path is exercised manually (spec §10) since it needs a live signal-cli-rest.

test("sendTest rejects an empty sender number before forwarding", async () => {
  const res = await handleSignal(null, {
    action: "sendTest",
    namespace: "default",
    number: "",
    recipients: ["+1555"],
  });
  expect(res.kind).toBe("error");
  if (res.kind === "error") {
    expect(res.status).toBe(422);
    expect(res.message).toMatch(/link your phone first/);
  }
});

test("sendTest rejects an empty recipients list before forwarding", async () => {
  const res = await handleSignal(null, {
    action: "sendTest",
    namespace: "default",
    number: "+1555",
    recipients: [],
  });
  expect(res.kind).toBe("error");
  if (res.kind === "error") {
    expect(res.status).toBe(422);
    expect(res.message).toMatch(/at least one recipient/);
  }
});

test("unknown action is a 422 error", async () => {
  const res = await handleSignal(null, {
    // @ts-expect-error — exercising the default branch
    action: "bogus",
  });
  expect(res.kind).toBe("error");
  if (res.kind === "error") expect(res.status).toBe(422);
});

// The assistant `setSignal` write only patches the keys it is given, so a
// recipients-only edit never clobbers the two-way toggle (read-modify-write is
// applied by patchConfig on top of these updates).
test("setSignal updates include only provided keys", () => {
  expect(signalConfigUpdates({ recipients: "+1555,+1666" })).toEqual({
    signalRecipients: "+1555,+1666",
  });
  expect(signalConfigUpdates({ inbound: false })).toEqual({ signalInbound: "false" });
});
