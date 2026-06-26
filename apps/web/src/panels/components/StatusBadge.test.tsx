// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("does not wrap by default (white-space: nowrap)", () => {
    render(<StatusBadge label="Running" />);
    expect(screen.getByText("Running")).toHaveStyle({ whiteSpace: "nowrap" });
  });

  it("wraps long text when wrap is set (white-space: normal)", () => {
    render(<StatusBadge label="Waiting for the instances to become active" wrap />);
    expect(
      screen.getByText("Waiting for the instances to become active"),
    ).toHaveStyle({ whiteSpace: "normal" });
  });
});
