// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFocusRow } from "./useFocusRow";
import { useCluster } from "@/store/cluster";

beforeEach(() => useCluster.getState().setFocusRequest(null));

const items = [{ metadata: { uid: "u1", name: "a", namespace: "prod" } }];

describe("useFocusRow", () => {
  it("expands + clears focusRequest when kind and key match", () => {
    useCluster.getState().setFocusRequest({ route: "/x", kind: "pod", key: "u1" });
    const expand = vi.fn();
    renderHook(() => useFocusRow("pod", items, (o) => o.metadata.uid!, expand));
    expect(expand).toHaveBeenCalledWith("u1");
    expect(useCluster.getState().focusRequest).toBeNull();
  });

  it("ignores a focusRequest for another kind", () => {
    useCluster.getState().setFocusRequest({ route: "/x", kind: "service", key: "u1" });
    const expand = vi.fn();
    renderHook(() => useFocusRow("pod", items, (o) => o.metadata.uid!, expand));
    expect(expand).not.toHaveBeenCalled();
    expect(useCluster.getState().focusRequest).not.toBeNull();
  });
});
