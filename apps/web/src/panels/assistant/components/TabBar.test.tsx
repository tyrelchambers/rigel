// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TabBar } from "./TabBar";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";

function wrap(value: Partial<AssistantContextValue>) {
  return render(
    <AssistantContext value={{ setTab: vi.fn(), tab: "overview", ...value } as AssistantContextValue}>
      <TabBar />
    </AssistantContext>,
  );
}

describe("TabBar", () => {
  it("includes an Agents tab when installed", () => {
    wrap({
      phase: "ready",
      d: { ready: { state: true }, clusterState: { audit: [], queue: [] }, liveIssues: [] } as never,
    });
    expect(screen.getByRole("tab", { name: /agents/i })).toBeInTheDocument();
  });
});
