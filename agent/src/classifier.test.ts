import { describe, expect, test } from "vitest";
import { levelFor } from "./classifier.js";
import { PRESETS } from "@rigel/k8s/src/actionLevels.js";

describe("levelFor", () => {
  test("returns the configured level for a known kind", () => {
    expect(levelFor("uncordon", { ...PRESETS.balanced, uncordon: "off" })).toBe("off");
    expect(levelFor("scale", PRESETS.balanced)).toBe("review");
  });

  test("an unknown kind is ask", () => {
    expect(levelFor("command", PRESETS.loose)).toBe("ask");
    expect(levelFor("drain", PRESETS.loose)).toBe("ask");
  });
});
