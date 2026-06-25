// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LimitsForm } from "./LimitsForm";
import { useCluster } from "@/store/cluster";
import type { AssistantLimits } from "@/lib/api";

const base: AssistantLimits = {
  pollIntervalMs: 30000,
  maxPerResourcePerHour: 3,
  maxPerNight: 10,
  maxAttemptsPerIncident: 2,
  confirmPolls: 2,
  namespaces: ["default"],
};

beforeEach(() => {
  // Seed the cluster store with the namespaces the dropdown lists.
  useCluster.setState({
    resources: { namespaces: { default: { metadata: { name: "default" } }, "kube-system": { metadata: { name: "kube-system" } } } },
  });
});

describe("LimitsForm", () => {
  it("renders the five number fields and the current namespace selection", () => {
    render(<LimitsForm value={base} onChange={() => {}} />);
    expect(screen.getByLabelText(/poll interval/i)).toHaveValue(30000);
    expect(screen.getByLabelText(/max per resource/i)).toHaveValue(3);
    expect(screen.getByLabelText(/max per night/i)).toHaveValue(10);
    expect(screen.getByLabelText(/attempts per incident/i)).toHaveValue(2);
    expect(screen.getByLabelText(/confirm polls/i)).toHaveValue(2);
    // The selected namespace shows as a chip in the dropdown trigger.
    expect(within(screen.getByRole("button", { name: /monitor namespaces/i })).getByText("default")).toBeInTheDocument();
  });

  it("emits a numeric value when a number field changes", async () => {
    const onChange = vi.fn();
    render(<LimitsForm value={base} onChange={onChange} />);
    const field = screen.getByLabelText(/confirm polls/i);
    await userEvent.clear(field);
    await userEvent.type(field, "4");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ confirmPolls: 4 }));
  });

  it("adds a namespace to the array when picked from the dropdown", async () => {
    const onChange = vi.fn();
    render(<LimitsForm value={base} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /monitor namespaces/i }));
    await userEvent.click(screen.getByRole("option", { name: /kube-system/i }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ namespaces: ["default", "kube-system"] }),
    );
  });

  it("clears the array (blank = all) when 'All namespaces' is chosen", async () => {
    const onChange = vi.fn();
    render(<LimitsForm value={base} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /monitor namespaces/i }));
    await userEvent.click(screen.getByRole("option", { name: /all namespaces/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ namespaces: [] }));
  });
});
