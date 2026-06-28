// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SettingsDerived } from "./useSettings";

const mutateAsync = vi.fn(async () => ({ success: true as const, stdout: "", stderr: "" }));
vi.mock("@/lib/api", () => ({ useAssistantAction: () => ({ mutateAsync, isPending: false }) }));

import { MatrixSection } from "./MatrixSection";

function derived(over: Partial<SettingsDerived> = {}): SettingsDerived {
  return {
    namespace: "default",
    status: "notDeployed",
    signalNumber: "", recipients: "", inbound: false, hasSavedNumber: false,
    matrixStatus: "notConnected", matrixHomeserverUrl: "", matrixUserId: "",
    matrixRoomId: "", matrixAllowedSenders: "", matrixInbound: false,
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
    render(<MatrixSection derived={derived({ matrixStatus: "connected", matrixHomeserverUrl: "https://hs", matrixUserId: "@rigel:hs", matrixRoomId: "!r:hs", matrixAllowedSenders: "@me:hs", matrixInbound: true })} />);
    expect(screen.getByText(/@rigel:hs/)).toBeInTheDocument();
    expect(screen.getByText(/@me:hs/)).toBeInTheDocument();
  });

  it("toggles two-way inbound via setMatrix", () => {
    render(<MatrixSection derived={derived({ matrixStatus: "connected", matrixHomeserverUrl: "https://hs", matrixUserId: "@rigel:hs", matrixRoomId: "!r:hs", matrixInbound: false })} />);
    fireEvent.click(screen.getByRole("switch", { name: /two-way/i }));
    expect(mutateAsync).toHaveBeenCalledWith({ action: "setMatrix", namespace: "default", matrixInbound: true });
  });
});
