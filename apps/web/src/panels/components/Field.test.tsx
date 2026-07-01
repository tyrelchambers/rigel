// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "./Field";

describe("Field", () => {
  it("renders label and value", () => {
    render(<Field label="Namespace">prod</Field>);
    expect(screen.getByText("Namespace")).toBeTruthy();
    expect(screen.getByText("prod")).toBeTruthy();
  });

  it("adds the full-width span class when span is set", () => {
    const { container } = render(<Field label="Selector" span>app=web</Field>);
    expect(container.querySelector(".col-span-2")).toBeTruthy();
  });
});
