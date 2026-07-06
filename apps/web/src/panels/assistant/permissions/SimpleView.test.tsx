// @vitest-environment jsdom
import { describe, it, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CAPABILITIES, DEFAULT_POLICY, setCapability, type RbacPolicy } from "@rigel/k8s";
import { SimpleView } from "./SimpleView";

describe("SimpleView", () => {
  it("renders one row per capability, one switch per non-baseline capability", () => {
    render(<SimpleView staged={DEFAULT_POLICY} onToggleCapability={vi.fn()} />);
    const nonBaselineCount = CAPABILITIES.filter((c) => !c.baseline).length;
    expect(screen.getAllByRole("switch")).toHaveLength(nonBaselineCount);
    for (const cap of CAPABILITIES) {
      expect(screen.getByText(cap.label)).toBeInTheDocument();
    }
  });

  it("clicking a safe, currently-off toggle calls onToggleCapability(id, true)", async () => {
    const onToggleCapability = vi.fn();
    render(<SimpleView staged={DEFAULT_POLICY} onToggleCapability={onToggleCapability} />);
    await userEvent.click(screen.getByRole("switch", { name: /Delete workloads/i }));
    expect(onToggleCapability).toHaveBeenCalledWith("deleteWorkloads", true);
  });

  it("clicking an on toggle calls onToggleCapability(id, false)", async () => {
    const onToggleCapability = vi.fn();
    render(<SimpleView staged={DEFAULT_POLICY} onToggleCapability={onToggleCapability} />);
    await userEvent.click(screen.getByRole("switch", { name: /Delete pods/i }));
    expect(onToggleCapability).toHaveBeenCalledWith("deletePods", false);
  });

  it("shows an amber Destructive chip for a destructive capability", () => {
    render(<SimpleView staged={DEFAULT_POLICY} onToggleCapability={vi.fn()} />);
    expect(screen.getAllByText("Destructive").length).toBeGreaterThan(0);
  });

  it("shows a red Secrets chip for the secrets capability", () => {
    render(<SimpleView staged={DEFAULT_POLICY} onToggleCapability={vi.fn()} />);
    expect(screen.getByText("Secrets")).toBeInTheDocument();
  });

  it("renders a mixed/indeterminate toggle when only some of a capability's cells are staged", () => {
    const partial = { cells: [CAPABILITIES.find((c) => c.id === "reversible")!.cells[0]] };
    render(<SimpleView staged={partial} onToggleCapability={vi.fn()} />);
    expect(screen.getByRole("switch", { name: /Restart/i })).toHaveAttribute("aria-checked", "mixed");
  });

  it("clicking a mixed toggle clears it", async () => {
    const onToggleCapability = vi.fn();
    const partial = { cells: [CAPABILITIES.find((c) => c.id === "reversible")!.cells[0]] };
    render(<SimpleView staged={partial} onToggleCapability={onToggleCapability} />);
    await userEvent.click(screen.getByRole("switch", { name: /Restart/i }));
    expect(onToggleCapability).toHaveBeenCalledWith("reversible", false);
  });

  test("clicking a partial capability clears it (one-click off)", async () => {
    const onToggle = vi.fn();
    const reversible = CAPABILITIES.find((c) => c.id === "reversible")!;
    const partial: RbacPolicy = { cells: [reversible.cells[0]] }; // some-but-not-all → partial
    render(<SimpleView staged={partial} onToggleCapability={onToggle} />);
    await userEvent.click(screen.getByRole("switch", { name: reversible.label }));
    expect(onToggle).toHaveBeenCalledWith("reversible", false);
  });

  test("the baseline read capability renders always-on, not a toggle", () => {
    render(<SimpleView staged={{ cells: [] }} onToggleCapability={() => {}} />);
    expect(screen.getByText("Always on")).toBeInTheDocument();
    // No interactive switch is rendered for the baseline row.
    expect(screen.queryByRole("switch", { name: "Read everything" })).not.toBeInTheDocument();
  });

  it("respects disabled", () => {
    render(<SimpleView staged={setCapability(DEFAULT_POLICY, "drain", true)} onToggleCapability={vi.fn()} disabled />);
    for (const el of screen.getAllByRole("switch")) {
      expect(el).toHaveAttribute("aria-disabled", "true");
    }
  });
});
