// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_POLICY, setCapability } from "@rigel/k8s";
import { ReviewDialog } from "./ReviewDialog";

describe("ReviewDialog", () => {
  it("lists added and removed cells in plain terms, and the target", () => {
    const staged = setCapability(DEFAULT_POLICY, "deleteWorkloads", true);
    render(
      <ReviewDialog
        open
        onOpenChange={vi.fn()}
        applied={DEFAULT_POLICY}
        staged={staged}
        targetLabel="Active cluster · kind-dev"
        confirming={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/Applying to Active cluster · kind-dev/)).toBeInTheDocument();
    expect(screen.getByText("+ delete deployments")).toBeInTheDocument();
  });

  it("lists removed cells with a minus", () => {
    const staged = { cells: DEFAULT_POLICY.cells.slice(1) };
    render(
      <ReviewDialog
        open
        onOpenChange={vi.fn()}
        applied={DEFAULT_POLICY}
        staged={staged}
        targetLabel="Active cluster · kind-dev"
        confirming={false}
        onConfirm={vi.fn()}
      />,
    );
    const [, resource, verb] = DEFAULT_POLICY.cells[0]!.split("|");
    expect(screen.getByText(`− ${verb} ${resource}`)).toBeInTheDocument();
  });

  it("confirming calls onConfirm", async () => {
    const onConfirm = vi.fn();
    const staged = setCapability(DEFAULT_POLICY, "drain", true);
    render(
      <ReviewDialog
        open
        onOpenChange={vi.fn()}
        applied={DEFAULT_POLICY}
        staged={staged}
        targetLabel="Active cluster · kind-dev"
        confirming={false}
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("cancel calls onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    const staged = setCapability(DEFAULT_POLICY, "drain", true);
    render(
      <ReviewDialog
        open
        onOpenChange={onOpenChange}
        applied={DEFAULT_POLICY}
        staged={staged}
        targetLabel="Active cluster · kind-dev"
        confirming={false}
        onConfirm={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables Apply when there are no pending changes", () => {
    render(
      <ReviewDialog
        open
        onOpenChange={vi.fn()}
        applied={DEFAULT_POLICY}
        staged={DEFAULT_POLICY}
        targetLabel="Active cluster · kind-dev"
        confirming={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^Apply$/ })).toBeDisabled();
  });
});
