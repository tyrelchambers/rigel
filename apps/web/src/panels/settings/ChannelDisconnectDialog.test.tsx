// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { ChannelDisconnectDialog } from "./ChannelDisconnectDialog";

const base = {
  channel: "Signal",
  description: "Notifications stop immediately.",
};

describe("ChannelDisconnectDialog", () => {
  it("renders no dialog when closed", () => {
    render(
      <ChannelDisconnectDialog open={false} onOpenChange={() => {}} onConfirm={() => {}} pending={false} {...base} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the destructive confirm copy for the given channel", () => {
    render(
      <ChannelDisconnectDialog open onOpenChange={() => {}} onConfirm={() => {}} pending={false} {...base} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/disconnect signal/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/notifications stop immediately/i)).toBeInTheDocument();
  });

  it("titles the dialog with whatever channel is passed", () => {
    render(
      <ChannelDisconnectDialog open onOpenChange={() => {}} onConfirm={() => {}} pending={false} channel="Matrix" description="x" />,
    );
    expect(within(screen.getByRole("dialog")).getByText(/disconnect matrix/i)).toBeInTheDocument();
  });

  it("calls onConfirm when the Disconnect button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ChannelDisconnectDialog open onOpenChange={() => {}} onConfirm={onConfirm} pending={false} {...base} />,
    );
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^disconnect$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenChange(false) when Cancel is clicked", () => {
    const onOpenChange = vi.fn();
    render(
      <ChannelDisconnectDialog open onOpenChange={onOpenChange} onConfirm={() => {}} pending={false} {...base} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables both buttons while pending", () => {
    render(
      <ChannelDisconnectDialog open onOpenChange={() => {}} onConfirm={() => {}} pending {...base} />,
    );
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /disconnecting/i })).toBeDisabled();
  });

  it("renders the error message inside the dialog when provided", () => {
    render(
      <ChannelDisconnectDialog open onOpenChange={() => {}} onConfirm={() => {}} pending={false} error="Boom" {...base} />,
    );
    expect(within(screen.getByRole("dialog")).getByText("Boom")).toBeInTheDocument();
  });
});
