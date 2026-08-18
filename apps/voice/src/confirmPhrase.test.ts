import { describe, expect, test } from "vitest";
import { matchConfirmPhrase, normalizeUtterance } from "./confirmPhrase.js";

describe("normalizeUtterance", () => {
  test("casing, punctuation and apostrophes collapse to bare words", () => {
    expect(normalizeUtterance("  Don't -- STOP!! ")).toBe("dont stop");
    expect(normalizeUtterance("Confirm.")).toBe("confirm");
  });
});

describe("matchConfirmPhrase", () => {
  test("the word confirm fires, with punctuation and casing ignored", () => {
    expect(matchConfirmPhrase("Confirm.")).toBe("confirm");
    expect(matchConfirmPhrase("okay, confirm it")).toBe("confirm");
    expect(matchConfirmPhrase("confirm the restart")).toBe("confirm");
    expect(matchConfirmPhrase("  CONFIRM  ")).toBe("confirm");
  });

  test("bare affirmatives never fire", () => {
    for (const t of ["yes", "yeah", "sure", "do it", "go ahead", "yep sounds good", "ok", "affirmative"]) {
      expect(matchConfirmPhrase(t)).toBe("other");
    }
  });

  test("cancel tokens cancel", () => {
    for (const t of ["cancel", "no", "stop", "wait", "abort", "never mind", "don't", "do not"]) {
      expect(matchConfirmPhrase(t)).toBe("cancel");
    }
  });

  test("cancel wins when both appear", () => {
    expect(matchConfirmPhrase("no, don't confirm that")).toBe("cancel");
    expect(matchConfirmPhrase("wait, confirm")).toBe("cancel");
    expect(matchConfirmPhrase("confirm... actually cancel")).toBe("cancel");
  });

  test("confirmation inside a longer unrelated sentence still counts only as the word", () => {
    expect(matchConfirmPhrase("can you confirm the pod count")).toBe("confirm");
    expect(matchConfirmPhrase("I want confirmation")).toBe("other");
    expect(matchConfirmPhrase("the deployment is unconfirmed")).toBe("other");
  });

  test("cancel tokens only match as whole words", () => {
    expect(matchConfirmPhrase("scale the nostalgia deployment")).toBe("other");
    expect(matchConfirmPhrase("check the nonprod namespace")).toBe("other");
  });

  test("anything else is other (falls through to a normal turn)", () => {
    expect(matchConfirmPhrase("actually scale it to three instead")).toBe("other");
    expect(matchConfirmPhrase("")).toBe("other");
  });
});
