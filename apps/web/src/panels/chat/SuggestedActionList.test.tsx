// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { SuggestedAction } from "@/lib/actionBlocks";
import { SuggestedActionList } from "./SuggestedActionList";

afterEach(cleanup);

const act = (label: string): SuggestedAction =>
  ({ kind: "restart", label, name: label, namespace: "default" }) as unknown as SuggestedAction;

describe("SuggestedActionList batch selection", () => {
  test("single action: no checkboxes, no batch bar", () => {
    render(<SuggestedActionList actions={[act("A")]} onAction={() => {}} onRunBatch={() => {}} />);
    expect(screen.queryByText(/Run selected/)).toBeNull();
    expect(screen.queryByLabelText(/batch/i)).toBeNull();
  });

  test("2+ actions: checkboxes (all selected by default) + batch bar", () => {
    render(<SuggestedActionList actions={[act("A"), act("B")]} onAction={() => {}} onRunBatch={() => {}} />);
    expect(screen.getByText("Run selected (2)")).toBeDefined();
    // both selected by default → both show the "Deselect from batch" control
    expect(screen.getAllByLabelText("Deselect from batch")).toHaveLength(2);
  });

  test("None/All toggle the selected count", () => {
    render(<SuggestedActionList actions={[act("A"), act("B")]} onAction={() => {}} onRunBatch={() => {}} />);
    fireEvent.click(screen.getByText("None"));
    const runNone = screen.getByText("Run selected (0)") as HTMLButtonElement;
    expect(runNone.disabled).toBe(true);
    fireEvent.click(screen.getByText("All"));
    expect(screen.getByText("Run selected (2)")).toBeDefined();
  });

  test("deselecting one runs the selected subset", () => {
    const onRunBatch = vi.fn();
    render(<SuggestedActionList actions={[act("A"), act("B")]} onAction={() => {}} onRunBatch={onRunBatch} />);
    // deselect the first → "Run selected (1)"
    fireEvent.click(screen.getAllByLabelText("Deselect from batch")[0]!);
    fireEvent.click(screen.getByText("Run selected (1)"));
    expect(onRunBatch).toHaveBeenCalledTimes(1);
    const passed = onRunBatch.mock.calls[0]![0] as SuggestedAction[];
    expect(passed.map((a) => a.label)).toEqual(["B"]);
  });

  test("single-action click still fires onAction", () => {
    const onAction = vi.fn();
    render(<SuggestedActionList actions={[act("A"), act("B")]} onAction={onAction} onRunBatch={() => {}} />);
    fireEvent.click(screen.getByText("A"));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
