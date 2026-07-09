// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CodeBlock } from "./CodeBlock";

describe("CodeBlock", () => {
  it("shows the fenced language in the header", () => {
    render(<CodeBlock><code className="language-yaml">foo: bar</code></CodeBlock>);
    expect(screen.getByText("yaml")).toBeInTheDocument();
    expect(screen.getByText("foo: bar")).toBeInTheDocument();
  });

  it("falls back to 'text' when no language is set", () => {
    render(<CodeBlock><code>plain body</code></CodeBlock>);
    expect(screen.getByText("text")).toBeInTheDocument();
  });
});
