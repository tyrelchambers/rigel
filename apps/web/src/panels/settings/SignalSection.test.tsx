// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import type { SettingsDerived } from "./useSettings";

const mutateAsync = vi.fn(async () => ({ success: true as const, stdout: "", stderr: "" }));
vi.mock("@/lib/api", () => ({
  useAssistantAction: () => ({ mutateAsync, isPending: false }),
  fetchSignalQR: vi.fn(),
  fetchSignalAccounts: vi.fn(),
  sendSignalTest: vi.fn(),
}));

import { SignalSection } from "./SignalSection";

function derived(over: Partial<SettingsDerived> = {}): SettingsDerived {
  return {
    namespace: "default",
    status: "linked",
    signalNumber: "+15550001111",
    recipients: "+15559998888",
    hasSavedNumber: true,
    matrixStatus: "notConnected",
    matrixHomeserverUrl: "",
    matrixUserId: "",
    matrixRoomId: "",
    matrixAllowedSenders: "",
    ...over,
  } as SettingsDerived;
}

const noop = () => {};

beforeEach(() => mutateAsync.mockClear());

describe("SignalSection — no two-way toggle", () => {
  it("renders linked state without a Two-way control (always-on inbound)", () => {
    render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
    expect(screen.queryByText(/two-way/i)).not.toBeInTheDocument();
  });
});

describe("SignalSection — disconnect", () => {
  it("shows a Disconnect trigger when linked", () => {
    render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  it("does not show Disconnect when not linked", () => {
    render(<SignalSection derived={derived({ status: "ready", signalNumber: "", hasSavedNumber: false })} applying={false} setApplying={noop} />);
    expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
  });

  it("opens a confirm dialog instead of calling setSignal directly", () => {
    render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Cancel closes the dialog without calling setSignal", () => {
    render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirming clears the Signal config via setSignal", async () => {
    render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^disconnect$/i }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setSignal",
        namespace: "default",
        apiUrl: "",
        number: "",
        recipients: "",
      }),
    );
  });

  it("closes the dialog after a successful disconnect", async () => {
    render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^disconnect$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open and shows the error when disconnect fails", async () => {
    mutateAsync.mockRejectedValueOnce(new Error("nope"));
    render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^disconnect$/i }));
    await waitFor(() => expect(screen.getByText("nope")).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
