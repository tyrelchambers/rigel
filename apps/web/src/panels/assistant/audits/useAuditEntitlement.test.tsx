// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { EntitlementPayload } from "@/lib/desktop";

vi.mock("@/shell/useEntitlement", () => ({ useEntitlement: vi.fn() }));
import { useEntitlement } from "@/shell/useEntitlement";
import { useAuditEntitlement } from "./useAuditEntitlement";

const pro = (audits: EntitlementPayload["audits"]): EntitlementPayload => ({
  plan: "pro", audits, cloudConnect: false, agentAutonomy: false, fetchedAt: "t",
});

beforeEach(() => vi.clearAllMocks());

describe("useAuditEntitlement", () => {
  it("locks everything when there is no payload (no bridge / not loaded → free)", () => {
    vi.mocked(useEntitlement).mockReturnValue({ payload: null, upgrade: vi.fn() });
    const { result } = renderHook(() => useAuditEntitlement());
    expect(result.current.unlocked).toEqual([]);
  });

  it("locks everything when the payload is free (empty audits)", () => {
    vi.mocked(useEntitlement).mockReturnValue({ payload: pro([]), upgrade: vi.fn() });
    const { result } = renderHook(() => useAuditEntitlement());
    expect(result.current.unlocked).toEqual([]);
  });

  it("unlocks exactly the payload's audit kinds", () => {
    vi.mocked(useEntitlement).mockReturnValue({ payload: pro(["security", "performance"]), upgrade: vi.fn() });
    const { result } = renderHook(() => useAuditEntitlement());
    expect(result.current.unlocked).toEqual(["security", "performance"]);
  });
});
