import { describe, it, expect, vi, beforeEach } from "vitest";
import { focusKeyFor, goToResource } from "./resourceNav";
import { useCluster } from "@/store/cluster";

beforeEach(() => useCluster.getState().setFocusRequest(null));

describe("focusKeyFor", () => {
  it("prefers uid", () => {
    expect(focusKeyFor({ metadata: { uid: "u1", name: "a", namespace: "prod" } })).toBe("u1");
  });
  it("falls back to namespace/name", () => {
    expect(focusKeyFor({ metadata: { name: "a", namespace: "prod" } })).toBe("prod/a");
  });
});

describe("goToResource", () => {
  it("navigates to the kind's route and sets a matching focusRequest", () => {
    const navigate = vi.fn();
    goToResource(navigate, { kind: "services", name: "backend", namespace: "prod", uid: "s1", key: "prod/backend", status: "ok" });
    expect(navigate).toHaveBeenCalledWith("/services");
    expect(useCluster.getState().focusRequest).toEqual({ route: "/services", kind: "service", key: "s1" });
  });

  it("uses namespace/name as the key when there is no uid", () => {
    const navigate = vi.fn();
    goToResource(navigate, { kind: "configmaps", name: "cfg", namespace: "prod", key: "prod/cfg", status: "ok" });
    expect(useCluster.getState().focusRequest!.key).toBe("prod/cfg");
  });
});
