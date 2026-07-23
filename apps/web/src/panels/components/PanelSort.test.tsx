// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PanelSort, applySort, type SortOption } from "./PanelSort";

interface Item { name: string; n: number }
const byN: SortOption<Item> = { value: "n", label: "N", compare: (a, b) => a.n - b.n || a.name.localeCompare(b.name) };
const items: Item[] = [
  { name: "b", n: 2 },
  { name: "a", n: 2 },
  { name: "c", n: 1 },
];

describe("applySort", () => {
  it("sorts ascending with the option comparator", () => {
    expect(applySort(items, byN, "asc").map((i) => i.name)).toEqual(["c", "a", "b"]);
  });
  it("reverses for descending", () => {
    expect(applySort(items, byN, "desc").map((i) => i.name)).toEqual(["b", "a", "c"]);
  });
  it("returns items unchanged when option is undefined", () => {
    expect(applySort(items, undefined, "asc")).toEqual(items);
  });
});

describe("PanelSort", () => {
  it("toggles direction when the button is clicked", () => {
    const onDir = vi.fn();
    render(
      <PanelSort
        options={[byN]}
        value="n"
        onValueChange={() => {}}
        direction="asc"
        onDirectionChange={onDir}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /sort direction/i }));
    expect(onDir).toHaveBeenCalledWith("desc");
  });
});
