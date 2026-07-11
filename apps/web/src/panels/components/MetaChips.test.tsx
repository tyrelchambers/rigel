// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MetaChips } from "./MetaChips";

beforeEach(() => {
  const writeText = () => Promise.resolve();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

describe("MetaChips", () => {
  it("renders nothing when there are no entries", () => {
    const { container } = render(<MetaChips title="Annotations" entries={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a plain entry's value text and a copy button", () => {
    render(<MetaChips title="Labels" entries={{ app: "big-o" }} />);
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.getByText("big-o")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("renders a JSON entry's clipped preview but not the full block until expanded", () => {
    const raw = JSON.stringify({ kind: "Deployment", spec: { replicas: 3 } });
    render(<MetaChips title="Annotations" entries={{ "kubectl.kubernetes.io/last-applied-configuration": raw }} />);
    expect(screen.getByText(raw)).toBeTruthy();
    expect(screen.queryByText('"replicas"')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByText('"replicas"')).toBeTruthy();
  });

  it("expand all reveals all json blocks, then a single row can be collapsed independently", () => {
    const a = JSON.stringify({ a: 1 });
    const b = JSON.stringify({ b: 2 });
    render(<MetaChips title="Annotations" entries={{ first: a, second: b }} />);

    expect(screen.queryByText('"a"')).toBeNull();
    expect(screen.queryByText('"b"')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));

    expect(screen.getByText('"a"')).toBeTruthy();
    expect(screen.getByText('"b"')).toBeTruthy();

    const collapseButtons = screen.getAllByRole("button", { name: "Collapse" });
    fireEvent.click(collapseButtons[0]);

    expect(screen.queryByText('"a"')).toBeNull();
    expect(screen.getByText('"b"')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand all" })).toBeTruthy();
  });

  it("renders an empty-value entry as a key-only chip with no copy button", () => {
    render(<MetaChips title="Labels" entries={{ standalone: "" }} />);
    expect(screen.getByText("standalone")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("does not show the expand-all toggle when there are no json entries", () => {
    render(<MetaChips title="Labels" entries={{ app: "big-o", tier: "web" }} />);
    expect(screen.queryByRole("button", { name: "Expand all" })).toBeNull();
  });

  it("copies the full raw value when the copy button is clicked", () => {
    const calls: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (text: string) => { calls.push(text); return Promise.resolve(); } },
      configurable: true,
    });
    render(<MetaChips title="Labels" entries={{ app: "big-o" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(calls).toEqual(["big-o"]);
  });
});
