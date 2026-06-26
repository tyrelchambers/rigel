// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCopyToClipboard } from "./useCopyToClipboard";

afterEach(cleanup);
afterEach(() => { vi.useRealTimers(); });

describe("useCopyToClipboard", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    writeText.mockClear();
  });

  test("copy calls writeText with the provided text", async () => {
    const { result } = renderHook(() => useCopyToClipboard());
    expect(result.current.copied).toBe(false);

    await act(async () => {
      result.current.copy("kubectl get pods");
    });

    expect(writeText).toHaveBeenCalledWith("kubectl get pods");
  });

  test("copied flips true after copy completes", async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      result.current.copy("some text");
    });

    expect(result.current.copied).toBe(true);
  });

  test("copied resets to false after resetMs using fake timers", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopyToClipboard(500));

    await act(async () => {
      result.current.copy("hello");
    });

    expect(result.current.copied).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current.copied).toBe(false);
  });
});
