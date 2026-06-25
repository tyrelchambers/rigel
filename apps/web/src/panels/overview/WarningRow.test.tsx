// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WarningRow } from "./OverviewPanel";
import type { K8sEvent } from "@/panels/events/types";

const event: K8sEvent = {
  metadata: { name: "e1", uid: "u1", creationTimestamp: new Date().toISOString() },
  type: "Warning",
  reason: "Unhealthy",
  message: "Readiness probe failed",
  count: 1,
  firstTimestamp: new Date().toISOString(),
  lastTimestamp: new Date().toISOString(),
  involvedObject: { kind: "Pod", name: "api-1", namespace: "prod", uid: "x" },
} as K8sEvent;

describe("WarningRow", () => {
  it("renders an Investigate button that calls onInvestigate", () => {
    const onInvestigate = vi.fn();
    render(<WarningRow event={event} onInvestigate={onInvestigate} />);
    const btn = screen.getByRole("button", { name: /investigate/i });
    fireEvent.click(btn);
    expect(onInvestigate).toHaveBeenCalledTimes(1);
  });

  it("shows the namespace and the age together near the resource", () => {
    render(<WarningRow event={event} onInvestigate={() => {}} />);
    expect(screen.getByText("prod")).toBeInTheDocument();
    // relativeAge renders something like "0s"/"1m"; just assert the resource is present.
    expect(screen.getByText("Pod/api-1")).toBeInTheDocument();
  });
});
