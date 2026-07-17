import { describe, expect, it } from "vitest";
import {
  buildLauncherGroups,
  buildFavoritesCells,
  matchesQuery,
  flattenVisible,
  nextIndex,
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

describe("nextIndex", () => {
  it("moves and wraps in a 3-column grid of 5", () => {
    expect(nextIndex(0, "ArrowRight", 3, 5)).toBe(1);
    expect(nextIndex(4, "ArrowRight", 3, 5)).toBe(0); // wrap end→start
    expect(nextIndex(0, "ArrowLeft", 3, 5)).toBe(4);  // wrap start→end
    expect(nextIndex(0, "ArrowDown", 3, 5)).toBe(3);
    expect(nextIndex(3, "ArrowDown", 3, 5)).toBe(1);  // (3+3)%5
    expect(nextIndex(1, "ArrowUp", 3, 5)).toBe(3);    // (1-3+5)%5
  });

  it("returns 0 for an empty grid", () => {
    expect(nextIndex(0, "ArrowRight", 3, 0)).toBe(0);
  });
});
