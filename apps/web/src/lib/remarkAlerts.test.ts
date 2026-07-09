import { describe, it, expect } from "vitest";
import { remarkAlerts } from "./remarkAlerts";

/** Build a minimal mdast blockquote wrapping one paragraph with a leading text node. */
function bq(text: string) {
  return {
    type: "root",
    children: [
      {
        type: "blockquote",
        children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
      },
    ],
  } as any;
}

const firstBq = (tree: any) => tree.children[0];
const firstText = (tree: any) => firstBq(tree).children[0].children[0];

describe("remarkAlerts", () => {
  it("tags a [!WARNING] blockquote and strips the marker", () => {
    const tree = bq("[!WARNING]\nDisk almost full");
    remarkAlerts()(tree);
    expect(firstBq(tree).data.hProperties.className).toContain("markdown-alert-warning");
    expect(firstText(tree).value).toBe("Disk almost full");
  });

  it("lowercases the type and is case-insensitive", () => {
    const tree = bq("[!Tip]\nlooks good");
    remarkAlerts()(tree);
    expect(firstBq(tree).data.hProperties.className).toContain("markdown-alert-tip");
  });

  it("removes an empty leading text node when the alert has no inline body", () => {
    const tree = bq("[!NOTE]\n");
    remarkAlerts()(tree);
    expect(firstBq(tree).data.hProperties.className).toContain("markdown-alert-note");
    expect(firstBq(tree).children[0].children.length).toBe(0);
  });

  it("leaves a plain blockquote untouched", () => {
    const tree = bq("just a normal quote");
    remarkAlerts()(tree);
    expect(firstBq(tree).data).toBeUndefined();
    expect(firstText(tree).value).toBe("just a normal quote");
  });

  it("ignores an unknown alert type", () => {
    const tree = bq("[!BOGUS]\nx");
    remarkAlerts()(tree);
    expect(firstBq(tree).data).toBeUndefined();
  });
});
