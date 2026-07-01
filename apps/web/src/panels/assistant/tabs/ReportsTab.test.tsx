// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ReportsTab } from "./ReportsTab";
import * as ctx from "../AssistantContext";

const sub = {
  id: "a",
  enabled: true,
  label: "Morning",
  channel: "signal" as const,
  days: [0, 1, 2, 3, 4, 5, 6],
  time: "07:00",
  timezone: "UTC",
  lookback: { mode: "sinceLast" as const },
  createdAt: "",
};

function mockCtx(run = vi.fn()) {
  vi.spyOn(ctx, "useAssistantCtx").mockReturnValue({
    d: {
      digests: [sub],
      digestState: { lastSentAt: { a: "2026-06-30T07:00:00.000Z" } },
      webhookURL: "",
    },
    ns: "default",
    working: false,
    run,
  } as unknown as ctx.AssistantContextValue);
  return run;
}

afterEach(() => vi.restoreAllMocks());

describe("ReportsTab", () => {
  it("lists subscriptions with their schedule", () => {
    mockCtx();
    render(<ReportsTab />);
    expect(screen.getByText("Morning")).toBeTruthy();
    expect(screen.getByText(/Daily at 07:00/)).toBeTruthy();
  });

  it("Edit dispatches a single saveDigest carrying digestId, not a delete", () => {
    const run = mockCtx();
    render(<ReportsTab />);
    fireEvent.click(screen.getByRole("button", { name: /edit: morning/i }));
    // Dialog opens; click Save digest without changing anything.
    fireEvent.click(screen.getByRole("button", { name: /save digest/i }));
    // Only one call: saveDigest with digestId (never deleteDigest).
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ action: "saveDigest", digestId: "a" }),
      expect.any(Function),
    );
    expect(run).not.toHaveBeenCalledWith(expect.objectContaining({ action: "deleteDigest" }), expect.anything());
  });

  it("dispatches sendDigestNow on Send now", () => {
    const run = mockCtx();
    render(<ReportsTab />);
    fireEvent.click(screen.getByRole("button", { name: /send now/i }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sendDigestNow", digestId: "a", digestMode: "send" }),
    );
  });
});
