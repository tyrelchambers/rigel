import { test, expect, describe } from "vitest";
import {
  buildPortForwardArgs,
  findFreeLocalPort,
  isLocalPortInUse,
  isValidLocalPort,
  PortForwardManager,
  type ActiveForward,
} from "./portForward";

// Pure functions run WITHOUT a cluster. The spawn path (start → running) needs a
// live kubectl + cluster and is exercised manually (spec §"Integration Tests").
// The bookkeeping tests below drive a real spawn against a bogus context so the
// process exits fast and we can observe the "failed" transition deterministically.

function fwd(partial: Partial<ActiveForward>): ActiveForward {
  return {
    id: partial.id ?? crypto.randomUUID(),
    namespace: partial.namespace ?? "default",
    service: partial.service ?? "svc",
    targetKind: partial.targetKind ?? "svc",
    localPort: partial.localPort ?? 8000,
    remotePort: partial.remotePort ?? 80,
    status: partial.status ?? "running",
    createdAt: partial.createdAt ?? Date.now(),
    failureMessage: partial.failureMessage,
  };
}

describe("buildPortForwardArgs", () => {
  test("without context omits --context", () => {
    expect(buildPortForwardArgs("svc", "my-service", "default", 8080, 3000)).toEqual([
      "port-forward",
      "svc/my-service",
      "8080:3000",
      "-n",
      "default",
    ]);
  });

  test("with context prepends --context in the right order", () => {
    expect(
      buildPortForwardArgs("svc", "my-service", "default", 8080, 3000, "minikube"),
    ).toEqual([
      "--context",
      "minikube",
      "port-forward",
      "svc/my-service",
      "8080:3000",
      "-n",
      "default",
    ]);
  });

  test("supports pod target kind", () => {
    expect(buildPortForwardArgs("pod", "my-pod", "kube-system", 9000, 9090)).toEqual([
      "port-forward",
      "pod/my-pod",
      "9000:9090",
      "-n",
      "kube-system",
    ]);
  });
});

describe("findFreeLocalPort", () => {
  test("empty list returns the start port", () => {
    expect(findFreeLocalPort([])).toBe(8000);
    expect(findFreeLocalPort([], 9000)).toBe(9000);
  });

  test("one forward on 8000 returns 8001", () => {
    expect(findFreeLocalPort([fwd({ localPort: 8000 })])).toBe(8001);
  });

  test("scattered forwards find the next available", () => {
    const active = [
      fwd({ localPort: 8000 }),
      fwd({ localPort: 8001 }),
      fwd({ localPort: 8003 }),
    ];
    expect(findFreeLocalPort(active)).toBe(8002);
  });

  test("failed forwards do not hold their port", () => {
    const active = [fwd({ localPort: 8000, status: "failed" })];
    expect(findFreeLocalPort(active)).toBe(8000);
  });

  test("no free ports throws", () => {
    const active = [fwd({ localPort: 65535 })];
    expect(() => findFreeLocalPort(active, 65535)).toThrow(/No free local ports/);
  });
});

describe("isLocalPortInUse", () => {
  test("non-failed forward on the port is in use", () => {
    expect(isLocalPortInUse(8000, [fwd({ localPort: 8000, status: "running" })])).toBe(true);
    expect(isLocalPortInUse(8000, [fwd({ localPort: 8000, status: "starting" })])).toBe(true);
  });

  test("failed forward on the port is NOT in use", () => {
    expect(isLocalPortInUse(8000, [fwd({ localPort: 8000, status: "failed" })])).toBe(false);
  });

  test("unrelated port is free", () => {
    expect(isLocalPortInUse(9999, [fwd({ localPort: 8000 })])).toBe(false);
  });
});

describe("isValidLocalPort", () => {
  test("accepts 1–65535 integers", () => {
    expect(isValidLocalPort(1)).toBe(true);
    expect(isValidLocalPort(8080)).toBe(true);
    expect(isValidLocalPort(65535)).toBe(true);
  });
  test("rejects out-of-range and non-integers", () => {
    expect(isValidLocalPort(0)).toBe(false);
    expect(isValidLocalPort(65536)).toBe(false);
    expect(isValidLocalPort(80.5)).toBe(false);
    expect(isValidLocalPort(NaN)).toBe(false);
  });
});

describe("PortForwardManager bookkeeping", () => {
  test("start validates required fields → 422", () => {
    const mgr = new PortForwardManager(null);
    const r = mgr.start({ namespace: "", service: "x", remotePort: 80 });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.status).toBe(422);
  });

  test("start rejects out-of-range remotePort → 422", () => {
    const mgr = new PortForwardManager(null);
    const r = mgr.start({ namespace: "default", service: "x", remotePort: 70000 });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.status).toBe(422);
  });

  test("start adds a 'starting' entry, then transitions to 'failed' on bad context", async () => {
    const mgr = new PortForwardManager("nonexistent-context-xyz");
    const r = mgr.start({ namespace: "default", service: "no-such-svc", remotePort: 80 });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;

    expect(r.forward.status).toBe("starting");
    expect(r.forward.localPort).toBe(8000);
    expect(r.forward.service).toBe("no-such-svc");
    expect(mgr.list()).toHaveLength(1);

    // kubectl exits quickly against a bogus context → entry flips to "failed".
    let status = mgr.list()[0]?.status;
    for (let i = 0; i < 50 && status === "starting"; i++) {
      await new Promise((res) => setTimeout(res, 100));
      status = mgr.list()[0]?.status;
    }
    expect(status).toBe("failed");
    const failed = mgr.list()[0];
    expect(failed?.failureMessage ?? "").not.toBe("");

    await mgr.stopAll();
  });

  test("duplicate non-failed local port → 409", () => {
    const mgr = new PortForwardManager("nonexistent-context-xyz");
    const first = mgr.start({
      namespace: "default",
      service: "a",
      remotePort: 80,
      localPort: 8055,
    });
    expect(first.kind).toBe("ok");
    // Immediately (still "starting"), a second on the same port conflicts.
    const second = mgr.start({
      namespace: "default",
      service: "b",
      remotePort: 80,
      localPort: 8055,
    });
    expect(second.kind).toBe("error");
    if (second.kind === "error") expect(second.status).toBe(409);
    void mgr.stopAll();
  });

  test("stop removes the entry and returns false for unknown id", async () => {
    const mgr = new PortForwardManager("nonexistent-context-xyz");
    const r = mgr.start({ namespace: "default", service: "a", remotePort: 80 });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(await mgr.stop(r.forward.id)).toBe(true);
    expect(mgr.list()).toHaveLength(0);
    expect(await mgr.stop("does-not-exist")).toBe(false);
  });

  test("auto-allocates the next free local port across concurrent starts", () => {
    const mgr = new PortForwardManager("nonexistent-context-xyz");
    const a = mgr.start({ namespace: "default", service: "a", remotePort: 80 });
    const b = mgr.start({ namespace: "default", service: "b", remotePort: 80 });
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    if (a.kind === "ok" && b.kind === "ok") {
      expect(a.forward.localPort).toBe(8000);
      expect(b.forward.localPort).toBe(8001);
    }
    void mgr.stopAll();
  });
});
