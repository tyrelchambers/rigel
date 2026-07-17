import { describe, it, expect } from "vitest";
import { releaseHighlights } from "./OverviewTab";

describe("releaseHighlights", () => {
  it("strips bullet / heading markers and drops blank lines", () => {
    const notes = "## What's new\n\n- Faster startup\n* Fixed a crash\n> quoted line\n\n";
    expect(releaseHighlights(notes)).toEqual([
      "What's new",
      "Faster startup",
      "Fixed a crash",
      "quoted line",
    ]);
  });

  it("caps the number of highlights", () => {
    const notes = Array.from({ length: 10 }, (_, i) => `- item ${i}`).join("\n");
    expect(releaseHighlights(notes, 3)).toEqual(["item 0", "item 1", "item 2"]);
  });

  it("handles a plain paragraph with no markers", () => {
    expect(releaseHighlights("Just a plain note.")).toEqual(["Just a plain note."]);
  });
});
