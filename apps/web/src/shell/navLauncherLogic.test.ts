import { describe, expect, it } from "vitest";
import {
  buildLauncherGroups,
  buildFavoritesCells,
  matchesQuery,
  flattenVisible,
  moveSelection,
  type LauncherGroup,
  type PanelInfo,
} from "./navLauncherLogic";

const META: Record<string, PanelInfo> = {
  overview: { title: "Overview", route: "/overview" },
  assistant: { title: "Assistant", route: "/assistant" },
  pods: { title: "Pods", route: "/pods" },
  deployments: { title: "Deployments", route: "/deployments" },
  secrets: { title: "Secrets", route: "/secrets" },
};

const GROUPS = [
  { title: null, panels: ["overview", "assistant"] },
  { title: "Workloads", panels: ["pods", "deployments", "ghost"] },
];

describe("buildLauncherGroups", () => {
  it("titles the null group 'General', alphabetizes cells, drops unknown keys", () => {
    const groups = buildLauncherGroups(GROUPS, META);
    expect(groups.map((g) => g.title)).toEqual(["General", "Workloads"]);
    expect(groups[0].cells.map((c) => c.title)).toEqual(["Assistant", "Overview"]);
    expect(groups[1].cells.map((c) => c.title)).toEqual(["Deployments", "Pods"]); // "ghost" dropped
    expect(groups[0].cells[0]).toEqual({ key: "assistant", title: "Assistant", route: "/assistant" });
  });
});

describe("buildFavoritesCells", () => {
  it("maps keys to cells alphabetically and drops unknown keys", () => {
    expect(buildFavoritesCells(["secrets", "deployments", "nope"], META).map((c) => c.title))
      .toEqual(["Deployments", "Secrets"]);
  });
});

describe("matchesQuery", () => {
  it("empty query matches everything; otherwise case-insensitive substring", () => {
    expect(matchesQuery("Deployments", "")).toBe(true);
    expect(matchesQuery("Deployments", "ploy")).toBe(true);
    expect(matchesQuery("Deployments", "POD")).toBe(false);
  });
});

describe("flattenVisible", () => {
  const groups: LauncherGroup[] = buildLauncherGroups(GROUPS, META);
  const favs = buildFavoritesCells(["secrets"], META);

  it("lists favorites first, then groups, in render order", () => {
    expect(flattenVisible(favs, groups, "").map((c) => c.key))
      .toEqual(["secrets", "assistant", "overview", "deployments", "pods"]);
  });

  it("filters by query across favorites and groups", () => {
    expect(flattenVisible(favs, groups, "o").map((c) => c.title))
      .toEqual(["Overview", "Deployments", "Pods"]);
  });
});

describe("moveSelection", () => {
  const sections = [1, 4, 2];

  it("steps and wraps horizontally across the whole flat list", () => {
    expect(moveSelection(0, "ArrowRight", sections, 3)).toBe(1);
    expect(moveSelection(6, "ArrowRight", sections, 3)).toBe(0);
    expect(moveSelection(0, "ArrowLeft", sections, 3)).toBe(6);
  });

  it("moves down by column within a section and crosses into the next", () => {
    expect(moveSelection(0, "ArrowDown", sections, 3)).toBe(1);
    expect(moveSelection(1, "ArrowDown", sections, 3)).toBe(4);
    expect(moveSelection(4, "ArrowDown", sections, 3)).toBe(5);
    expect(moveSelection(5, "ArrowDown", sections, 3)).toBe(0);
  });

  it("clamps to the last cell when the target column is missing", () => {
    expect(moveSelection(2, "ArrowDown", sections, 3)).toBe(4);
  });

  it("moves up by column and crosses into the previous section's last row", () => {
    expect(moveSelection(4, "ArrowUp", sections, 3)).toBe(1);
    expect(moveSelection(1, "ArrowUp", sections, 3)).toBe(0);
    expect(moveSelection(5, "ArrowUp", sections, 3)).toBe(4);
  });

  it("returns 0 for an empty grid", () => {
    expect(moveSelection(0, "ArrowRight", [], 3)).toBe(0);
  });
});
