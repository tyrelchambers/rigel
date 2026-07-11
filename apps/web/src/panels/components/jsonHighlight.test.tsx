// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { JsonHighlight } from "./jsonHighlight";

describe("JsonHighlight", () => {
  it("renders the same text as JSON.stringify(data, null, 2)", () => {
    const data = { a: 1, b: "x", c: [true, null] };
    const { container } = render(<JsonHighlight data={data} />);
    expect(container.textContent).toBe(JSON.stringify(data, null, 2));
  });

  it("colors an object key", () => {
    const { container } = render(<JsonHighlight data={{ foo: "bar" }} />);
    const spans = [...container.querySelectorAll("span")];
    const keySpan = spans.find((s) => s.textContent === '"foo"');
    expect(keySpan).toBeTruthy();
    expect(keySpan!.style.color).toBe("rgb(125, 211, 252)");
  });

  it("colors a string value", () => {
    const { container } = render(<JsonHighlight data={{ foo: "bar" }} />);
    const spans = [...container.querySelectorAll("span")];
    const valueSpan = spans.find((s) => s.textContent === '"bar"');
    expect(valueSpan).toBeTruthy();
    expect(valueSpan!.style.color).toBe("rgb(16, 185, 129)");
  });

  it("colors a number", () => {
    const { container } = render(<JsonHighlight data={{ n: 42 }} />);
    const spans = [...container.querySelectorAll("span")];
    const numberSpan = spans.find((s) => s.textContent === "42");
    expect(numberSpan).toBeTruthy();
    expect(numberSpan!.style.color).toBe("rgb(226, 179, 62)");
  });
});
