// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";

// ---- Mocks must be hoisted before any imports ----

// Mock sonner so we can assert on the toast lifecycle without a DOM host.
const toastLoading = vi.fn((..._a: unknown[]) => "toast-1");
const toastSuccess = vi.fn((..._a: unknown[]) => undefined);
const toastError = vi.fn((..._a: unknown[]) => undefined);
const toastCustom = vi.fn((..._a: unknown[]) => "toast-custom-1");
const toastDismiss = vi.fn((..._a: unknown[]) => undefined);
vi.mock("sonner", () => ({
  toast: {
    loading: (...a: unknown[]) => toastLoading(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    custom: (...a: unknown[]) => toastCustom(...a),
    dismiss: (...a: unknown[]) => toastDismiss(...a),
  },
}));

// Mock the REST network call.
const executeAction = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve());
vi.mock("@/lib/api", () => ({
  executeAction: (...a: unknown[]) => executeAction(...a),
}));

// Capture action event callbacks so tests can simulate WS events.
const actionEventCallbacks = new Map<string, (e: unknown) => void>();
const mockRunAction = vi.fn((..._a: unknown[]) => undefined);
const mockOnActionEvent = vi.fn((id: string, cb: (e: unknown) => void) => {
  actionEventCallbacks.set(id, cb);
  return () => { actionEventCallbacks.delete(id); };
});
vi.mock("@/lib/ws", () => ({
  runAction: (...a: unknown[]) => mockRunAction(...a),
  onActionEvent: (id: string, cb: (e: unknown) => void) => mockOnActionEvent(id, cb),
}));

// Mock ActionProgressToast so actionRunner.tsx doesn't need jsdom rendering.
vi.mock("@/panels/chat/ActionProgressToast", () => ({
  ActionProgressToast: () => React.createElement("div", null, "toast"),
}));

import { runActionInBackground } from "./actionRunner";
import type { ActionBlock } from "@/lib/api";

// A streaming action kind (anything not in purge/applyManifest/proposeRepoFix).
const streamingAction: ActionBlock = {
  kind: "command",
  label: "Run command",
  name: "my-deploy",
  namespace: "default",
};

// A drain action (also streaming).
const drainAction: ActionBlock = {
  kind: "drain",
  node: "k8s-truenas",
  label: "Drain node k8s-truenas",
};

// REST-only actions.
const purgeAction: ActionBlock = { kind: "purge", name: "my-app", namespace: "default" };
const applyManifestAction: ActionBlock = { kind: "applyManifest", manifest: "apiVersion: v1" };
const proposeRepoFixAction: ActionBlock = { kind: "proposeRepoFix", source: "github.com/foo/bar" };

beforeEach(() => {
  toastLoading.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  toastCustom.mockClear();
  toastDismiss.mockClear();
  mockRunAction.mockClear();
  mockOnActionEvent.mockClear();
  executeAction.mockReset();
  actionEventCallbacks.clear();
});

// ---- Streaming path tests ----

describe("runActionInBackground — streaming path", () => {
  it("calls runAction (WS) and NOT executeAction for a command kind", () => {
    runActionInBackground({ action: streamingAction, label: "Run command", commandString: "kubectl exec ..." });

    expect(mockRunAction).toHaveBeenCalledTimes(1);
    expect(mockRunAction.mock.calls[0]![0]).toMatch(/^act-/); // runId
    expect(mockRunAction.mock.calls[0]![1]).toBe(streamingAction);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("calls runAction for a drain action (streaming)", () => {
    runActionInBackground({ action: drainAction, label: "Drain node k8s-truenas", commandString: "kubectl drain k8s-truenas" });

    expect(mockRunAction).toHaveBeenCalledTimes(1);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("renders a custom toast with duration Infinity", () => {
    runActionInBackground({ action: streamingAction, label: "Run command", commandString: "kubectl ..." });

    expect(toastCustom).toHaveBeenCalledTimes(1);
    expect(toastCustom.mock.calls[0]![1]).toMatchObject({ duration: Infinity });
    expect(toastLoading).not.toHaveBeenCalled();
  });

  it("subscribes to action events with the same runId used for runAction", () => {
    runActionInBackground({ action: streamingAction, label: "Run command", commandString: "kubectl ..." });

    const runId = mockRunAction.mock.calls[0]![0] as string;
    expect(mockOnActionEvent).toHaveBeenCalledWith(runId, expect.any(Function));
  });

  it("fires onResult with code 0 when action.done fires (fromChat)", () => {
    const onResult = vi.fn();
    runActionInBackground({
      action: streamingAction,
      label: "Run command",
      commandString: "kubectl ...",
      fromChat: true,
      onResult,
    });

    const runId = mockRunAction.mock.calls[0]![0] as string;
    const cb = actionEventCallbacks.get(runId)!;
    cb({ type: "action.done", id: runId, code: 0 });

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ result: { code: 0, stdout: "", stderr: "" } }),
    );
  });

  it("fires onResult with code 1 when action.done fires with non-zero code (fromChat)", () => {
    const onResult = vi.fn();
    runActionInBackground({
      action: streamingAction,
      label: "Run command",
      commandString: "kubectl ...",
      fromChat: true,
      onResult,
    });

    const runId = mockRunAction.mock.calls[0]![0] as string;
    const cb = actionEventCallbacks.get(runId)!;
    cb({ type: "action.done", id: runId, code: 2 });

    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ result: { code: 2, stdout: "", stderr: "" } }),
    );
  });

  it("fires onResult on action.error (fromChat)", () => {
    const onResult = vi.fn();
    runActionInBackground({
      action: streamingAction,
      label: "Run command",
      commandString: "kubectl ...",
      fromChat: true,
      onResult,
    });

    const runId = mockRunAction.mock.calls[0]![0] as string;
    const cb = actionEventCallbacks.get(runId)!;
    cb({ type: "action.error", id: runId, message: "connection lost" });

    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ result: { code: 1, stdout: "", stderr: "connection lost" } }),
    );
  });

  it("does NOT call onResult when not fromChat even if action.done fires", () => {
    const onResult = vi.fn();
    runActionInBackground({
      action: streamingAction,
      label: "Run command",
      commandString: "kubectl ...",
      onResult, // fromChat not set
    });

    const runId = mockRunAction.mock.calls[0]![0] as string;
    const cb = actionEventCallbacks.get(runId)!;
    cb({ type: "action.done", id: runId, code: 0 });

    expect(onResult).not.toHaveBeenCalled();
  });

  it("fires onResult exactly once on a terminal event and unsubscribes (no re-trigger)", () => {
    const onResult = vi.fn();
    runActionInBackground({
      action: streamingAction,
      label: "Run command",
      commandString: "kubectl ...",
      fromChat: true,
      onResult,
    });

    const runId = mockRunAction.mock.calls[0]![0] as string;

    // Dispatch like ws.ts does: only deliver to a listener that is still
    // registered. After unsub the id is gone, so a stray frame is dropped —
    // the production guarantee that protects the once-only invariant.
    const dispatch = (e: unknown) => {
      const cb = actionEventCallbacks.get(runId);
      if (cb) cb(e);
    };

    // Terminal event (success) closes the loop exactly once.
    dispatch({ type: "action.done", id: runId, code: 0 });
    expect(onResult).toHaveBeenCalledTimes(1);

    // The actionRunner subscription was removed after the terminal event:
    // the mock's unsub deletes the listener, so the id is no longer registered.
    expect(actionEventCallbacks.has(runId)).toBe(false);

    // A second (stray) terminal frame must NOT re-trigger onResult — it is
    // dropped because the listener was already removed. Locks the once-only
    // invariant (done OR error, never twice).
    dispatch({ type: "action.done", id: runId, code: 0 });
    dispatch({ type: "action.error", id: runId, message: "late stray event" });
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});

// ---- REST path tests (purge / applyManifest / proposeRepoFix) ----

describe("runActionInBackground — REST path", () => {
  it("calls executeAction and NOT runAction for a purge action", () => {
    executeAction.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    runActionInBackground({ action: purgeAction, label: "Purge my-app", commandString: "helm uninstall my-app" });

    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(mockRunAction).not.toHaveBeenCalled();
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastCustom).not.toHaveBeenCalled();
  });

  it("calls executeAction and NOT runAction for applyManifest", () => {
    executeAction.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    runActionInBackground({ action: applyManifestAction, label: "Apply manifest", commandString: "kubectl apply -f -" });

    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("calls executeAction and NOT runAction for proposeRepoFix", () => {
    executeAction.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    runActionInBackground({ action: proposeRepoFixAction, label: "Propose fix", commandString: "gh pr create ..." });

    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("shows a loading toast immediately and resolves to success", async () => {
    executeAction.mockResolvedValue({ code: 0, stdout: "applied", stderr: "" });
    const onResult = vi.fn();

    runActionInBackground({
      action: applyManifestAction,
      label: "Apply manifest",
      commandString: "kubectl apply -f -",
      fromChat: true,
      onResult,
    });

    expect(toastLoading).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess.mock.calls[0]?.[1]).toMatchObject({ id: "toast-1" });
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ result: { code: 0, stdout: "applied", stderr: "" } }),
    );
  });

  it("treats a non-zero exit code as an error toast", async () => {
    executeAction.mockResolvedValue({ code: 1, stdout: "", stderr: "cannot apply" });
    const onResult = vi.fn();

    runActionInBackground({
      action: applyManifestAction,
      label: "Apply manifest",
      commandString: "kubectl apply -f -",
      fromChat: true,
      onResult,
    });

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError.mock.calls[0]?.[1]).toMatchObject({ id: "toast-1", description: "cannot apply" });
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ result: { code: 1, stdout: "", stderr: "cannot apply" } }),
    );
  });

  it("reports a thrown network error and still closes the chat loop", async () => {
    executeAction.mockRejectedValue(new Error("503 Service Unavailable"));
    const onResult = vi.fn();

    runActionInBackground({
      action: applyManifestAction,
      label: "Apply manifest",
      commandString: "kubectl apply -f -",
      fromChat: true,
      onResult,
    });

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[1]).toMatchObject({ description: "503 Service Unavailable" });
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ result: { code: 1, stdout: "", stderr: "503 Service Unavailable" } }),
    );
  });

  it("does not call onResult when not from chat", async () => {
    executeAction.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const onResult = vi.fn();

    runActionInBackground({
      action: applyManifestAction,
      label: "Apply manifest",
      commandString: "kubectl apply -f -",
      onResult,
    });

    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(onResult).not.toHaveBeenCalled();
  });
});
