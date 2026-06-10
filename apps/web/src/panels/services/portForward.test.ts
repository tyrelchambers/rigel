import { describe, expect, test } from "vitest";
import type { Service } from "./types";
import {
  formatForwardLabel,
  getForwardingServices,
  buildLocalPortDefault,
  validateLocalPort,
  type ActiveForward,
} from "./portForward";

function fwd(partial: Partial<ActiveForward>): ActiveForward {
  return {
    id: partial.id ?? "id-1",
    namespace: partial.namespace ?? "default",
    service: partial.service ?? "my-service",
    targetKind: partial.targetKind ?? "svc",
    localPort: partial.localPort ?? 8080,
    remotePort: partial.remotePort ?? 3000,
    status: partial.status ?? "running",
    createdAt: partial.createdAt ?? 0,
    pod: partial.pod,
    failureMessage: partial.failureMessage,
  };
}

function svc(name: string, uid: string, namespace = "default"): Service {
  return { metadata: { name, uid, namespace }, spec: { type: "ClusterIP" } };
}

describe("formatForwardLabel", () => {
  test("formats svc/name:remotePort", () => {
    expect(formatForwardLabel(fwd({ service: "web", remotePort: 8080 }))).toBe("svc/web:8080");
  });

  test("formats pod/name:remotePort", () => {
    expect(
      formatForwardLabel(fwd({ targetKind: "pod", pod: "web-0", service: undefined, remotePort: 9090 })),
    ).toBe("pod/web-0:9090");
  });
});

describe("getForwardingServices", () => {
  const services = [svc("web", "uid-web"), svc("api", "uid-api"), svc("web", "uid-web-prod", "prod")];

  test("returns uids of services with a running forward", () => {
    const forwards = [fwd({ service: "web", namespace: "default", status: "running" })];
    expect(getForwardingServices(forwards, services)).toEqual(new Set(["uid-web"]));
  });

  test("ignores starting and failed forwards", () => {
    const forwards = [
      fwd({ service: "api", status: "starting" }),
      fwd({ service: "web", status: "failed" }),
    ];
    expect(getForwardingServices(forwards, services).size).toBe(0);
  });

  test("matches on namespace too (same name, different ns)", () => {
    const forwards = [fwd({ service: "web", namespace: "prod", status: "running" })];
    expect(getForwardingServices(forwards, services)).toEqual(new Set(["uid-web-prod"]));
  });

  test("empty when no forwards", () => {
    expect(getForwardingServices([], services).size).toBe(0);
  });
});

describe("buildLocalPortDefault", () => {
  test("uses the remote port when valid", () => {
    expect(buildLocalPortDefault(3000)).toBe(3000);
  });
  test("falls back to 8000 when absent or out of range", () => {
    expect(buildLocalPortDefault(undefined)).toBe(8000);
    expect(buildLocalPortDefault(70000)).toBe(8000);
  });
});

describe("validateLocalPort", () => {
  test("empty is an error", () => {
    expect(validateLocalPort("", [])).toMatch(/required/);
    expect(validateLocalPort("   ", [])).toMatch(/required/);
  });

  test("non-numeric is an error", () => {
    expect(validateLocalPort("80a", [])).toMatch(/number/);
  });

  test("out-of-range is an error", () => {
    expect(validateLocalPort("0", [])).toMatch(/between 1 and 65535/);
    expect(validateLocalPort("65536", [])).toMatch(/between 1 and 65535/);
  });

  test("in-use port is an error", () => {
    const active = [fwd({ localPort: 8080, status: "running" })];
    expect(validateLocalPort("8080", active)).toMatch(/already in use/);
  });

  test("failed forward does not block the port", () => {
    const active = [fwd({ localPort: 8080, status: "failed" })];
    expect(validateLocalPort("8080", active)).toBeNull();
  });

  test("valid free port returns null", () => {
    expect(validateLocalPort("8090", [])).toBeNull();
  });
});
