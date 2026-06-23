// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LimitsForm } from "./LimitsForm";
import type { AssistantLimits } from "@/lib/api";

const base: AssistantLimits = {
  pollIntervalMs: 30000,
  maxPerResourcePerHour: 3,
  maxPerNight: 10,
  maxAttemptsPerIncident: 2,
  confirmPolls: 2,
  namespaces: ["default"],
};

describe("LimitsForm", () => {
  it("renders all six labeled inputs with current values", () => {
    render(<LimitsForm value={base} onChange={() => {}} />);
    expect(screen.getByLabelText(/poll interval/i)).toHaveValue(30000);
    expect(screen.getByLabelText(/max per resource/i)).toHaveValue(3);
    expect(screen.getByLabelText(/max per night/i)).toHaveValue(10);
    expect(screen.getByLabelText(/attempts per incident/i)).toHaveValue(2);
    expect(screen.getByLabelText(/confirm polls/i)).toHaveValue(2);
    expect(screen.getByLabelText(/monitor namespaces/i)).toHaveValue("default");
  });

  it("emits a numeric value when a number field changes", async () => {
    const onChange = vi.fn();
    render(<LimitsForm value={base} onChange={onChange} />);
    const field = screen.getByLabelText(/confirm polls/i);
    await userEvent.clear(field);
    await userEvent.type(field, "4");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ confirmPolls: 4 }));
  });

  it("emits a string[] for monitor namespaces from a comma list", async () => {
    const onChange = vi.fn();
    render(<LimitsForm value={base} onChange={onChange} />);
    const field = screen.getByLabelText(/monitor namespaces/i);
    await userEvent.clear(field);
    await userEvent.type(field, "default, kube-system");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ namespaces: ["default", "kube-system"] }));
  });
});
