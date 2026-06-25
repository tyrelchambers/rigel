// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetaChips } from "./MetaChips";

describe("MetaChips", () => {
  it("renders a chip per entry with the count and a key: value tooltip", () => {
    render(<MetaChips title="Labels" entries={{ app: "big-o", tier: "web" }} />);
    expect(screen.getByText("Labels")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    const chip = screen.getByText("app: big-o");
    expect(chip).toBeTruthy();
    expect(chip.getAttribute("title")).toBe("app: big-o");
  });

  it("shows just the key when the value is empty", () => {
    render(<MetaChips title="Labels" entries={{ "standalone": "" }} />);
    expect(screen.getByText("standalone")).toBeTruthy();
  });

  it("renders nothing when there are no entries", () => {
    const { container } = render(<MetaChips title="Annotations" entries={undefined} />);
    expect(container.firstChild).toBeNull();
  });
});
