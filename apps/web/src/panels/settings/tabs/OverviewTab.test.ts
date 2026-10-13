// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { releaseHighlights } from "./OverviewTab";

const GITHUB_NOTES = `<h2>What's Changed</h2>
<ul>
<li>feat(agent): uncordon nodes by <a class="user-mention notranslate" href="https://github.com/tyrelchambers">@tyrelchambers</a> in <a class="issue-link js-issue-link" href="https://github.com/tyrelchambers/rigel/pull/115">#115</a></li>
<li>chore: remove the voice assistant by <a href="https://github.com/tyrelchambers">@tyrelchambers</a> in <a href="https://github.com/tyrelchambers/rigel/pull/118">#118</a></li>
</ul>
<p><strong>Full Changelog</strong>: <a href="https://github.com/tyrelchambers/rigel/compare/v0.12.0...v0.13.0">v0.12.0...v0.13.0</a></p>`;

describe("releaseHighlights", () => {
  it("reads the list items out of GitHub's rendered HTML, as text", () => {
    expect(releaseHighlights(GITHUB_NOTES)).toEqual([
      "feat(agent): uncordon nodes by @tyrelchambers in #115",
      "chore: remove the voice assistant by @tyrelchambers in #118",
    ]);
  });

  it("caps the number of highlights", () => {
    const notes = `<ul>${Array.from({ length: 10 }, (_, i) => `<li>item ${i}</li>`).join("")}</ul>`;
    expect(releaseHighlights(notes, 3)).toEqual(["item 0", "item 1", "item 2"]);
  });

  it("has no highlights when the notes carry no list", () => {
    expect(releaseHighlights("<p>Just a plain note.</p>")).toEqual([]);
  });
});
