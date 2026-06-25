import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock sonner so we can assert on the toast lifecycle without a DOM host.
const toastLoading = vi.fn((..._a: unknown[]) => "toast-1");
const toastSuccess = vi.fn((..._a: unknown[]) => undefined);
const toastError = vi.fn((..._a: unknown[]) => undefined);
vi.mock("sonner", () => ({
  toast: {
    loading: (...a: unknown[]) => toastLoading(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

// Mock the network call.
const executeAction = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve());
vi.mock("@/lib/api", () => ({
  executeAction: (...a: unknown[]) => executeAction(...a),
}));

import { runActionInBackground } from "./actionRunner";
import type { ActionBlock } from "@/lib/api";

const action: ActionBlock = { kind: "drain", node: "k8s-truenas", label: "Drain node k8s-truenas" };

beforeEach(() => {
  toastLoading.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  executeAction.mockReset();
});

describe("runActionInBackground", () => {
  it("shows a loading toast immediately and resolves to success", async () => {
    executeAction.mockResolvedValue({ code: 0, stdout: "node/k8s-truenas drained", stderr: "" });
    const onResult = vi.fn();

    runActionInBackground({ action, label: "Drain node k8s-truenas", commandString: "kubectl drain k8s-truenas", fromChat: true, onResult });

    // loading toast fires synchronously (no awaiting the command)
    expect(toastLoading).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
    // success toast updates the same toast id
    expect(toastSuccess.mock.calls[0]?.[1]).toMatchObject({ id: "toast-1" });
    // chat loop closed with the real result
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ result: { code: 0, stdout: "node/k8s-truenas drained", stderr: "" } }),
    );
  });

  it("treats a non-zero exit code as an error toast", async () => {
    executeAction.mockResolvedValue({ code: 1, stdout: "", stderr: "error: cannot evict pod" });
    const onResult = vi.fn();

    runActionInBackground({ action, label: "Drain node", commandString: "kubectl drain k8s-truenas", fromChat: true, onResult });

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError.mock.calls[0]?.[1]).toMatchObject({ id: "toast-1", description: "error: cannot evict pod" });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ result: { code: 1, stdout: "", stderr: "error: cannot evict pod" } }));
  });

  it("reports a thrown network error and still closes the chat loop", async () => {
    executeAction.mockRejectedValue(new Error("503 Service Unavailable"));
    const onResult = vi.fn();

    runActionInBackground({ action, label: "Drain node", commandString: "kubectl drain k8s-truenas", fromChat: true, onResult });

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[1]).toMatchObject({ description: "503 Service Unavailable" });
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ result: { code: 1, stdout: "", stderr: "503 Service Unavailable" } }),
    );
  });

  it("does not call onResult when not from chat", async () => {
    executeAction.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const onResult = vi.fn();

    runActionInBackground({ action, label: "Drain node", commandString: "kubectl drain k8s-truenas", onResult });

    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(onResult).not.toHaveBeenCalled();
  });
});
