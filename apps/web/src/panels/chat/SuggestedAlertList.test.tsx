// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { SuggestedAlert } from "@/lib/actionBlocks";
import { SuggestedAlertList } from "./SuggestedAlertList";

afterEach(cleanup);

// Mock the useAssistantAction hook so the component can render without a
// QueryClient provider and without hitting the network.
const mockMutate = vi.fn();
vi.mock("@/lib/api", () => ({
  useAssistantAction: () => ({
    mutate: mockMutate,
    isPending: false,
  }),
}));

const alert = (label: string): SuggestedAlert => ({
  label,
  text: `Alert me when ${label}`,
  target: { scope: "cluster" },
  condition: { type: "crashLoop" },
});

describe("SuggestedAlertList", () => {
  test("renders null when alerts is empty", () => {
    const { container } = render(
      <SuggestedAlertList alerts={[]} namespace="default" />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders one button per alert", () => {
    render(
      <SuggestedAlertList
        alerts={[alert("crash-loop"), alert("oom-killed")]}
        namespace="default"
      />,
    );
    expect(screen.getByText("crash-loop")).toBeDefined();
    expect(screen.getByText("oom-killed")).toBeDefined();
  });

  test("clicking a button calls mutate with saveAlert action", () => {
    render(
      <SuggestedAlertList alerts={[alert("crash-loop")]} namespace="default" />,
    );
    fireEvent.click(screen.getByText("crash-loop"));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    const [req] = mockMutate.mock.calls[0] as [{ action: string; namespace: string; alert: SuggestedAlert }];
    expect(req.action).toBe("saveAlert");
    expect(req.namespace).toBe("default");
    expect(req.alert.label).toBe("crash-loop");
  });
});
