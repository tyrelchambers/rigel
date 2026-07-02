// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { SignalDisconnectDialog } from "./SignalDisconnectDialog";

describe("SignalDisconnectDialog", () => {
  it("renders no dialog when closed", () => {
    render(
      <SignalDisconnectDialog open={false} onOpenChange={() => {}} onConfirm={() => {}} pending={false} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the destructive confirm copy when open", () => {
    render(
      <SignalDisconnectDialog open onOpenChange={() => {}} onConfirm={() => {}} pending={false} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/disconnect signal/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/notifications stop immediately/i)).toBeInTheDocument();
  });

  it("calls onConfirm when the Disconnect button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <SignalDisconnectDialog open onOpenChange={() => {}} onConfirm={onConfirm} pending={false} />,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^disconnect$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenChange(false) when Cancel is clicked", () => {
    const onOpenChange = vi.fn();
    render(
      <SignalDisconnectDialog open onOpenChange={onOpenChange} onConfirm={() => {}} pending={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables both buttons while pending", () => {
    render(
      <SignalDisconnectDialog open onOpenChange={() => {}} onConfirm={() => {}} pending />,
    );
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /disconnecting/i })).toBeDisabled();
  });

  it("renders the error message inside the dialog when provided", () => {
    render(
      <SignalDisconnectDialog open onOpenChange={() => {}} onConfirm={() => {}} pending={false} error="Boom" />,
    );
    expect(within(screen.getByRole("dialog")).getByText("Boom")).toBeInTheDocument();
  });
});
