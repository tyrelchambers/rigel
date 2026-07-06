// @vitest-environment jsdom
import { describe, it, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cell, DEFAULT_POLICY, VERBS } from "@rigel/k8s";
import { AdvancedView } from "./AdvancedView";

describe("AdvancedView", () => {
  it("shows all 7 verbs as column headers", () => {
    render(<AdvancedView staged={DEFAULT_POLICY} onToggleCell={vi.fn()} />);
    for (const v of VERBS) {
      expect(screen.getByRole("columnheader", { name: v })).toBeInTheDocument();
    }
  });

  it("groups rows under an apiGroup header, including core", () => {
    render(<AdvancedView staged={DEFAULT_POLICY} onToggleCell={vi.fn()} />);
    expect(screen.getByText("core")).toBeInTheDocument();
    expect(screen.getByText("apps")).toBeInTheDocument();
    expect(screen.getByText("batch")).toBeInTheDocument();
    expect(screen.getByText("networking.k8s.io")).toBeInTheDocument();
  });

  it("reflects the staged policy: pods/get is on by default, pods/delete is on, secrets/get is off", () => {
    render(<AdvancedView staged={DEFAULT_POLICY} onToggleCell={vi.fn()} />);
    expect(screen.getByLabelText("pods get")).toBeChecked();
    expect(screen.getByLabelText("pods delete")).toBeChecked();
    expect(screen.getByLabelText("secrets get")).not.toBeChecked();
  });

  it("clicking a cell toggles it via onToggleCell", async () => {
    const onToggleCell = vi.fn();
    render(<AdvancedView staged={DEFAULT_POLICY} onToggleCell={onToggleCell} />);
    await userEvent.click(screen.getByLabelText("deployments delete"));
    expect(onToggleCell).toHaveBeenCalledWith(cell("apps", "deployments", "delete"), true);
  });

  it("pods/eviction only has the create column interactive", () => {
    render(<AdvancedView staged={DEFAULT_POLICY} onToggleCell={vi.fn()} />);
    expect(screen.getByLabelText("pods/eviction create")).not.toBeDisabled();
    expect(screen.getByLabelText("pods/eviction get")).toBeDisabled();
    expect(screen.getByLabelText("pods/eviction delete")).toBeDisabled();
  });

  it("nodes only has get/list/watch/patch interactive", () => {
    render(<AdvancedView staged={DEFAULT_POLICY} onToggleCell={vi.fn()} />);
    expect(screen.getByLabelText("nodes patch")).not.toBeDisabled();
    expect(screen.getByLabelText("nodes delete")).toBeDisabled();
    expect(screen.getByLabelText("nodes create")).toBeDisabled();
  });

  it("shows the lock note about secrets and roles/rolebindings", () => {
    render(<AdvancedView staged={DEFAULT_POLICY} onToggleCell={vi.fn()} />);
    expect(
      screen.getByText(/Secrets and roles \/ rolebindings aren't editable here/),
    ).toBeInTheDocument();
  });

  it("respects disabled on every cell", () => {
    render(<AdvancedView staged={DEFAULT_POLICY} onToggleCell={vi.fn()} disabled />);
    expect(screen.getByLabelText("pods get")).toBeDisabled();
  });

  test("baseline read cells render checked and disabled even when absent from the policy", () => {
    render(<AdvancedView staged={{ cells: [] }} onToggleCell={() => {}} />);
    const podsGet = screen.getByRole("checkbox", { name: "pods get" });
    expect(podsGet).toBeChecked();
    expect(podsGet).toBeDisabled();
  });
});
