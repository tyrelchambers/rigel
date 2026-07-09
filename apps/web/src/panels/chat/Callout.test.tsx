// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatBlockquote } from "./Callout";

describe("ChatBlockquote", () => {
  it("renders a WARNING callout label for an alert className", () => {
    render(<ChatBlockquote className="markdown-alert markdown-alert-warning">Disk full</ChatBlockquote>);
    expect(screen.getByText("WARNING")).toBeInTheDocument();
    expect(screen.getByText("Disk full")).toBeInTheDocument();
  });

  it("renders a plain quote with no text label", () => {
    render(<ChatBlockquote>just a quote</ChatBlockquote>);
    expect(screen.getByText("just a quote")).toBeInTheDocument();
    expect(screen.queryByText("QUOTE")).not.toBeInTheDocument();
    expect(screen.queryByText("NOTE")).not.toBeInTheDocument();
  });

  it("maps caution to the CAUTION label", () => {
    render(<ChatBlockquote className="markdown-alert markdown-alert-caution">danger</ChatBlockquote>);
    expect(screen.getByText("CAUTION")).toBeInTheDocument();
  });
});
