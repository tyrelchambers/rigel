// @vitest-environment jsdom
import { afterEach, expect, test, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const account = { id: "1", email: "a@b.co", name: "Jane" };
const me = vi.fn();
const requestCode = vi.fn();
const verifyCode = vi.fn();
const signOut = vi.fn();
vi.mock("@/lib/desktop", () => ({
  rigel: { account: { me: (...a: unknown[]) => me(...a), requestCode: (...a: unknown[]) => requestCode(...a), verifyCode: (...a: unknown[]) => verifyCode(...a), signOut: (...a: unknown[]) => signOut(...a) } },
}));

beforeEach(() => { me.mockReset(); requestCode.mockReset(); verifyCode.mockReset(); signOut.mockReset(); });
afterEach(() => vi.clearAllMocks());

test("resolves to signed-in when me() returns a payload", async () => {
  me.mockResolvedValue({ account });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  expect(result.current.status).toBe("loading");
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
  expect(result.current.account).toEqual(account);
});

test("resolves to signed-out when me() returns null", async () => {
  me.mockResolvedValue(null);
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-out"));
  expect(result.current.account).toBeNull();
});

test("verifyCode success refreshes to signed-in", async () => {
  me.mockResolvedValueOnce(null).mockResolvedValue({ account });
  verifyCode.mockResolvedValue({ ok: true, account });
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-out"));
  await act(async () => { await result.current.verifyCode("a@b.co", "123456"); });
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
});

test("signOut returns to signed-out", async () => {
  me.mockResolvedValue({ account });
  signOut.mockResolvedValue(undefined);
  const { useAccount } = await import("./useAccount");
  const { result } = renderHook(() => useAccount());
  await waitFor(() => expect(result.current.status).toBe("signed-in"));
  await act(async () => { await result.current.signOut(); });
  expect(result.current.status).toBe("signed-out");
  expect(signOut).toHaveBeenCalled();
});
