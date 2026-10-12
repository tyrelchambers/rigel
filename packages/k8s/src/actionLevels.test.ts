import { describe, expect, test } from "vitest";
import { ACTION_KINDS, PRESETS, matchPreset, parseActionLevels, serializeActionLevels } from "./actionLevels";

describe("parseActionLevels", () => {
  test("missing key → Balanced", () => {
    expect(parseActionLevels(undefined)).toEqual(PRESETS.balanced);
  });

  test("a kind missing from the map uses its Balanced value", () => {
    const l = parseActionLevels(JSON.stringify({ scale: "off" }));
    expect(l.scale).toBe("off");
    expect(l.uncordon).toBe(PRESETS.balanced.uncordon);
  });

  test("an unrecognised value fails closed to ask", () => {
    expect(parseActionLevels(JSON.stringify({ restart: "yolo" })).restart).toBe("ask");
  });

  test("unparseable JSON → every kind ask", () => {
    const l = parseActionLevels("{nope");
    for (const k of ACTION_KINDS) expect(l[k.kind]).toBe("ask");
  });

  test("unknown kinds in the stored map are dropped", () => {
    expect(Object.keys(parseActionLevels(JSON.stringify({ drain: "auto" })))).toEqual(ACTION_KINDS.map((k) => k.kind));
  });
});

describe("presets", () => {
  test("Balanced matches the spec table", () => {
    expect(PRESETS.balanced).toEqual({
      restart: "auto", rollback: "auto", deletePod: "auto", cordon: "auto",
      uncordon: "auto", scale: "review", setEnv: "review", openFixPR: "review",
    });
  });

  test("Loose and Strict match the spec table", () => {
    expect(PRESETS.loose).toEqual({
      restart: "auto", rollback: "auto", deletePod: "auto", cordon: "auto",
      uncordon: "auto", scale: "auto", setEnv: "review", openFixPR: "review",
    });
    expect(PRESETS.strict).toEqual({
      restart: "review", rollback: "ask", deletePod: "review", cordon: "ask",
      uncordon: "ask", scale: "ask", setEnv: "ask", openFixPR: "ask",
    });
  });

  test("matchPreset finds the equal preset, else null", () => {
    expect(matchPreset(PRESETS.strict)).toBe("strict");
    expect(matchPreset({ ...PRESETS.balanced, restart: "off" })).toBeNull();
  });

  test("serialize round-trips through parse", () => {
    expect(parseActionLevels(serializeActionLevels(PRESETS.loose))).toEqual(PRESETS.loose);
  });
});
