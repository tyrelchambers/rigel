// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import type { SettingsDerived } from "./useSettings";

const mutateAsync = vi.fn(async () => ({ success: true as const, stdout: "", stderr: "" }));
vi.mock("@/lib/api", () => ({ useAssistantAction: () => ({ mutateAsync, isPending: false }) }));

import { MatrixSection } from "./MatrixSection";

function derived(over: Partial<SettingsDerived> = {}): SettingsDerived {
  return {
    namespace: "default",
    status: "notDeployed",
    signalNumber: "", recipients: "", hasSavedNumber: false,
    matrixStatus: "notConnected", matrixHomeserverUrl: "", matrixUserId: "",
    matrixRoomId: "", matrixAllowedSenders: "",
    webhookUrls: {}, connectedChannels: [], notifyChannels: [],
    ...over,
  } as SettingsDerived;
}

beforeEach(() => mutateAsync.mockClear());

describe("MatrixSection", () => {
  it("shows a Connect call to action when not connected", () => {
    render(<MatrixSection derived={derived()} />);
    expect(screen.getByRole("button", { name: /connect matrix/i })).toBeInTheDocument();
  });

  it("shows the connected summary (bot id + allowed senders)", () => {
    render(<MatrixSection derived={derived({ matrixStatus: "connected", matrixHomeserverUrl: "https://hs", matrixUserId: "@rigel:hs", matrixRoomId: "!r:hs", matrixAllowedSenders: "@me:hs" })} />);
    expect(screen.getByText(/@rigel:hs/)).toBeInTheDocument();
    expect(screen.getByText(/@me:hs/)).toBeInTheDocument();
  });

  it("shows the three detail captions when connected", () => {
    render(<MatrixSection derived={derived({ matrixStatus: "connected", matrixHomeserverUrl: "https://hs", matrixUserId: "@rigel:hs", matrixRoomId: "!r:hs", matrixAllowedSenders: "@me:hs" })} />);
    expect(screen.getByText("HOMESERVER")).toBeInTheDocument();
    expect(screen.getByText("BOT")).toBeInTheDocument();
    expect(screen.getByText("ALLOWED SENDERS")).toBeInTheDocument();
  });

  it("renders the connected card without a Two-way control (always-on inbound)", () => {
    render(<MatrixSection derived={derived({ matrixStatus: "connected", matrixHomeserverUrl: "https://hs", matrixUserId: "@rigel:hs", matrixRoomId: "!r:hs" })} />);
    expect(screen.queryByText(/two-way/i)).not.toBeInTheDocument();
  });

  it("shows a Notifications toggle reflecting the effective notify set", () => {
    render(<MatrixSection derived={derived({ matrixStatus: "connected", matrixHomeserverUrl: "https://hs", matrixUserId: "@rigel:hs", matrixRoomId: "!r:hs", notifyChannels: ["matrix"] })} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("toggling Notifications calls setChannel with channelNotify", async () => {
    render(<MatrixSection derived={derived({ matrixStatus: "connected", matrixHomeserverUrl: "https://hs", matrixUserId: "@rigel:hs", matrixRoomId: "!r:hs", notifyChannels: ["matrix"] })} />);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setChannel",
        namespace: "default",
        channel: "matrix",
        channelNotify: false,
      }),
    );
  });

  const connected = () => derived({ matrixStatus: "connected", matrixHomeserverUrl: "https://hs", matrixUserId: "@rigel:hs", matrixRoomId: "!r:hs" });

  it("clicking Disconnect opens a confirm dialog instead of calling setMatrix directly", () => {
    render(<MatrixSection derived={connected()} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).getByText(/disconnect matrix/i)).toBeInTheDocument();
  });

  it("Cancel closes the dialog without calling setMatrix", () => {
    render(<MatrixSection derived={connected()} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirming clears the Matrix config via setMatrix and closes the dialog", async () => {
    render(<MatrixSection derived={connected()} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^disconnect$/i }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ action: "setMatrix", matrixHomeserverUrl: "" })),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open and shows the error when disconnect fails", async () => {
    mutateAsync.mockRejectedValueOnce(new Error("nope"));
    render(<MatrixSection derived={connected()} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^disconnect$/i }));
    await waitFor(() => expect(screen.getByText("nope")).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
