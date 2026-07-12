// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mutateAsync = vi.fn(async () => ({ success: true as const, stdout: "", stderr: "" }));
let isPending = false;
vi.mock("@/lib/api", () => ({ useAssistantAction: () => ({ mutateAsync, isPending }) }));

import { NotifyToggle } from "./NotifyToggle";

beforeEach(() => {
  mutateAsync.mockClear();
  isPending = false;
});

describe("NotifyToggle", () => {
  it("reflects the enabled prop on the switch", () => {
    render(<NotifyToggle channelId="discord" namespace="default" enabled />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("reflects a disabled (off) channel", () => {
    render(<NotifyToggle channelId="discord" namespace="default" enabled={false} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("toggling on calls setChannel with channelNotify: true", async () => {
    render(<NotifyToggle channelId="discord" namespace="ns1" enabled={false} />);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setChannel",
        namespace: "ns1",
        channel: "discord",
        channelNotify: true,
      }),
    );
  });

  it("toggling off calls setChannel with channelNotify: false", async () => {
    render(<NotifyToggle channelId="slack" namespace="default" enabled />);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setChannel",
        namespace: "default",
        channel: "slack",
        channelNotify: false,
      }),
    );
  });

  it("is disabled while the mutation is pending", () => {
    isPending = true;
    render(<NotifyToggle channelId="matrix" namespace="default" enabled />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("data-disabled");
    fireEvent.click(sw);
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
