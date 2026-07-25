// @vitest-environment jsdom
import { afterEach, expect, test, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const account = { id: "1", email: "a@b.co", name: "Jane" };
const status = vi.fn();
const startSignIn = vi.fn();
const signOut = vi.fn();
let changedCb: (() => void) | null = null;
vi.mock("@/lib/desktop", () => ({
  rigel: {
    account: {
      status: (...a: unknown[]) => status(...a),
      startSignIn: (...a: unknown[]) => startSignIn(...a),
      signOut: (...a: unknown[]) => signOut(...a),
      onChanged: (cb: () => void) => { changedCb = cb; return () => { changedCb = null; }; },
    },
  },
}));

beforeEach(() => { status.mockReset(); startSignIn.mockReset(); signOut.mockReset(); changedCb = null; });
afterEach(() => vi.clearAllMocks());

test("resolves to signed-in when status() reports signedIn", async () => {
  status.mockResolvedValue({ signedIn: true, account, orgs: [] });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  expect(result.current.status).toBe("loading");
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
  expect(result.current.account).toEqual(account);
});

test("signed-in even when account is null (offline, token retained)", async () => {
  status.mockResolvedValue({ signedIn: true, account: null, orgs: [] });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
  expect(result.current.account).toBeNull();
});

test("resolves to signed-out when status() reports not signed in", async () => {
  status.mockResolvedValue({ signedIn: false, account: null, orgs: [] });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-out"));
});

test("startSignIn calls through and refreshes so pendingSignIn surfaces", async () => {
  const pendingSignIn = { email: "a@b.co", expiresAt: 1_700_000_000_000 };
  status
    .mockResolvedValueOnce({ signedIn: false, account: null, orgs: [], pendingSignIn: null })
    .mockResolvedValue({ signedIn: false, account: null, orgs: [], pendingSignIn });
  startSignIn.mockResolvedValue({ ok: true, status: 200 });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-out"));
  expect(result.current.pendingSignIn).toBeNull();
  await act(async () => { await result.current.startSignIn("a@b.co"); });
  expect(startSignIn).toHaveBeenCalledWith("a@b.co");
  await waitFor(() => expect(result.current.pendingSignIn).toEqual(pendingSignIn));
});

test("a failed startSignIn does not refresh and leaves pendingSignIn null", async () => {
  status.mockResolvedValue({ signedIn: false, account: null, orgs: [], pendingSignIn: null });
  startSignIn.mockResolvedValue({ ok: false, status: 429 });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-out"));
  status.mockClear();
  let r: { ok: boolean; status: number } | undefined;
  await act(async () => { r = await result.current.startSignIn("a@b.co"); });
  expect(r).toEqual({ ok: false, status: 429 });
  expect(status).not.toHaveBeenCalled();
  expect(result.current.pendingSignIn).toBeNull();
});

test("re-checks and flips to signed-in when main signals a change (magic link)", async () => {
  status.mockResolvedValueOnce({ signedIn: false, account: null, orgs: [] }).mockResolvedValue({ signedIn: true, account, orgs: [] });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-out"));
  await act(async () => { changedCb?.(); });
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
});

test("signOut returns to signed-out", async () => {
  status.mockResolvedValue({ signedIn: true, account, orgs: [] });
  signOut.mockResolvedValue(undefined);
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
  await act(async () => { await result.current.signOut(); });
  expect(result.current.status).toBe("signed-out");
  expect(signOut).toHaveBeenCalled();
});

test("exposes orgs from status()", async () => {
  const org = { id: "o1", kind: "personal" as const, name: "Jane", role: "owner" as const };
  status.mockResolvedValue({ signedIn: true, account, orgs: [org] });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
  expect(result.current.orgs).toEqual([org]);
});
