// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { ActionEvent } from "@/lib/ws";

// Capture the callback registered per id so tests can fire events.
const eventCallbacks = new Map<string, (e: ActionEvent) => void>();
const mockOnActionEvent = vi.fn((id: string, cb: (e: ActionEvent) => void) => {
  eventCallbacks.set(id, cb);
  // Return an unsubscribe function.
  return () => { eventCallbacks.delete(id); };
});

vi.mock("@/lib/ws", () => ({
  onActionEvent: (id: string, cb: (e: ActionEvent) => void) => mockOnActionEvent(id, cb),
}));

import { ActionProgressToast } from "./ActionProgressToast";

afterEach(() => {
  cleanup();
  eventCallbacks.clear();
  mockOnActionEvent.mockClear();
});

/** Helper: fire an event on the given run id. */
function emit(id: string, e: ActionEvent) {
  const cb = eventCallbacks.get(id);
  if (!cb) throw new Error(`No listener registered for id "${id}"`);
  act(() => cb(e));
}

describe("ActionProgressToast", () => {
  test("subscribes with the given id and renders running state", () => {
    render(<ActionProgressToast id="r1" label="Delete X" />);

    expect(mockOnActionEvent).toHaveBeenCalledWith("r1", expect.any(Function));
    // Running label
    expect(screen.getByText("Running: Delete X")).toBeDefined();
    // Streaming cursor visible (expanded by default)
    expect(screen.getByText(/█ streaming…/)).toBeDefined();
  });

  test("appends progress lines and they render in the output panel", () => {
    render(<ActionProgressToast id="r1" label="Delete X" />);

    emit("r1", { type: "action.progress", id: "r1", line: "line one" });
    emit("r1", { type: "action.progress", id: "r1", line: "line two" });

    expect(screen.getByText("line one")).toBeDefined();
    expect(screen.getByText("line two")).toBeDefined();
  });

  test("chevron toggle collapses and expands the output panel", () => {
    render(<ActionProgressToast id="r1" label="Delete X" />);

    // Cursor visible by default (expanded)
    expect(screen.getByText(/█ streaming…/)).toBeDefined();

    // Collapse
    fireEvent.click(screen.getByLabelText("Collapse output"));
    expect(screen.queryByText(/█ streaming…/)).toBeNull();

    // Expand again
    fireEvent.click(screen.getByLabelText("Expand output"));
    expect(screen.getByText(/█ streaming…/)).toBeDefined();
  });

  test("action.done code 0 → done state with check and line count", () => {
    render(<ActionProgressToast id="r1" label="Delete X" />);

    emit("r1", { type: "action.progress", id: "r1", line: "step 1" });
    emit("r1", { type: "action.progress", id: "r1", line: "step 2" });
    emit("r1", { type: "action.done", id: "r1", code: 0 });

    // Label without "Running:" prefix
    expect(screen.getByText("Delete X")).toBeDefined();
    // Meta line
    expect(screen.getByText(/Done · 2 lines/)).toBeDefined();
    // Cursor gone
    expect(screen.queryByText(/█ streaming…/)).toBeNull();
  });

  test("action.error → error state shows the message", () => {
    render(<ActionProgressToast id="r2" label="Drain node" />);

    emit("r2", { type: "action.progress", id: "r2", line: "starting drain" });
    emit("r2", { type: "action.error", id: "r2", message: "node not found" });

    expect(screen.getByText("Drain node")).toBeDefined();
    expect(screen.getByText("node not found")).toBeDefined();
    expect(screen.queryByText(/█ streaming…/)).toBeNull();
  });

  test("action.done non-zero code → error state with exit code message", () => {
    render(<ActionProgressToast id="r3" label="Scale down" />);

    emit("r3", { type: "action.done", id: "r3", code: 1 });

    expect(screen.getByText("Scale down")).toBeDefined();
    expect(screen.getByText(/Exited with code 1/)).toBeDefined();
  });

  test("unsubscribes on unmount", () => {
    const { unmount } = render(<ActionProgressToast id="r1" label="Delete X" />);

    expect(eventCallbacks.has("r1")).toBe(true);

    unmount();

    expect(eventCallbacks.has("r1")).toBe(false);
  });

  test("done state: 1 line uses singular 'line'", () => {
    render(<ActionProgressToast id="r4" label="Restart" />);

    emit("r4", { type: "action.progress", id: "r4", line: "restarted" });
    emit("r4", { type: "action.done", id: "r4", code: 0 });

    expect(screen.getByText(/Done · 1 line$/)).toBeDefined();
  });
});
