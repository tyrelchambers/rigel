import { describe, expect, test } from "vitest";
import { markAppearance, spectrumAt, visualStateFor, VOICE_SPECTRUM, voiceHalo, wavyCircle } from "./VoiceMark";

test("wavyCircle produces a closed path around the center", () => {
  const d = wavyCircle(12, 12, 8);
  expect(d.startsWith("M")).toBe(true);
  expect(d.endsWith("Z")).toBe(true);
  expect(d.split("L").length).toBeGreaterThan(40);
});

test("radius modulation stays within the wave amplitude", () => {
  // Coordinates are emitted at 3 decimals, so allow that much slack.
  const slack = 1e-3;
  const d = wavyCircle(0, 0, 10, 6, 0.5);
  const coords = d.replace(/[MLZ]/g, "").trim().split(/\s+/).map(Number);
  for (let i = 0; i < coords.length; i += 2) {
    const r = Math.hypot(coords[i]!, coords[i + 1]!);
    expect(r).toBeGreaterThanOrEqual(9.5 - slack);
    expect(r).toBeLessThanOrEqual(10.5 + slack);
  }
});

test("a bigger amplitude makes a wavier ring", () => {
  const radii = (d: string) => {
    const coords = d.replace(/[MLZ]/g, "").trim().split(/\s+/).map(Number);
    const out: number[] = [];
    for (let i = 0; i < coords.length; i += 2) out.push(Math.hypot(coords[i]!, coords[i + 1]!));
    return out;
  };
  const spread = (rs: number[]) => Math.max(...rs) - Math.min(...rs);
  expect(spread(radii(wavyCircle(0, 0, 10, 6, 1.5)))).toBeGreaterThan(
    spread(radii(wavyCircle(0, 0, 10, 6, 0.5))),
  );
});

describe("visualStateFor", () => {
  test("a room that is not connected reads disconnected whatever the agent says", () => {
    expect(visualStateFor("speaking", false)).toBe("disconnected");
    expect(visualStateFor(undefined, false)).toBe("disconnected");
  });

  test("thinking and speaking pass through while connected", () => {
    expect(visualStateFor("thinking", true)).toBe("thinking");
    expect(visualStateFor("speaking", true)).toBe("speaking");
  });

  test("failed passes through while connected, distinct from every listening state", () => {
    expect(visualStateFor("failed", true)).toBe("failed");
  });

  test("every other connected agent state is listening, because the mic is live; failed is excluded", () => {
    for (const s of ["initializing", "connecting", "idle", "pre-connect-buffering", "disconnected", undefined] as const) {
      expect(visualStateFor(s, true)).toBe("listening");
    }
    expect(visualStateFor("failed", true)).not.toBe("listening");
  });
});

describe("markAppearance", () => {
  test("disconnected is tertiary, still, unglowing and fully opaque", () => {
    const a = markAppearance("disconnected", 0.9, false);
    expect(a.color).toBe("var(--fg-tertiary)");
    expect(a.ripple).toBe(0);
    expect(a.pulsing).toBe(false);
    expect(a.opacity).toBe(1);
    expect(a.glow).toBeNull();
  });

  test("the three live states key off the three spectrum stops", () => {
    expect(markAppearance("listening", 0, false).color).toBe(VOICE_SPECTRUM[0]);
    expect(markAppearance("thinking", 0, false).color).toBe(VOICE_SPECTRUM[1]);
    expect(markAppearance("speaking", 0, false).color).toBe(VOICE_SPECTRUM[2]);
  });

  test("only the live states glow, each in its own colour", () => {
    for (const [i, s] of (["listening", "thinking", "speaking"] as const).entries()) {
      expect(markAppearance(s, 0, false).glow).toBe(voiceHalo(VOICE_SPECTRUM[i]!, "55"));
    }
    expect(markAppearance("disconnected", 0.9, false).glow).toBeNull();
    expect(markAppearance("failed", 0.9, false).glow).toBeNull();
  });

  test("the halo fades to a fully transparent edge of the same colour", () => {
    expect(voiceHalo("#38bdf8", "55")).toContain("#38bdf800 100%");
  });

  test("listening and speaking couple the ripple to the level", () => {
    expect(markAppearance("listening", 0.4, false).ripple).toBeCloseTo(0.4);
    expect(markAppearance("speaking", 0.7, false).ripple).toBeCloseTo(0.7);
  });

  test("the level is clamped into 0..1 and NaN reads as silence", () => {
    expect(markAppearance("listening", 4, false).ripple).toBe(1);
    expect(markAppearance("listening", -2, false).ripple).toBe(0);
    expect(markAppearance("listening", Number.NaN, false).ripple).toBe(0);
  });

  test("thinking pulses instead of rippling, so it never tracks the mic", () => {
    const a = markAppearance("thinking", 0.9, false);
    expect(a.pulsing).toBe(true);
    expect(a.ripple).toBe(0);
  });

  test("reduced motion removes all motion and separates the states by opacity", () => {
    const states = ["listening", "thinking", "speaking"] as const;
    const seen = states.map((s) => markAppearance(s, 0.9, true));
    for (const a of seen) {
      expect(a.ripple).toBe(0);
      expect(a.pulsing).toBe(false);
    }
    expect(new Set(seen.map((a) => a.opacity)).size).toBe(3);
  });

  test("reduced motion keeps the halo, which is colour rather than motion", () => {
    for (const s of ["listening", "thinking", "speaking"] as const) {
      expect(markAppearance(s, 0.9, true).glow).toBe(markAppearance(s, 0.9, false).glow);
    }
  });

  test("failed reads as a problem, not activity: no ripple, no pulse, no glow, destructive color", () => {
    const a = markAppearance("failed", 0.9, false);
    expect(a.color).toBe("var(--destructive)");
    expect(a.ripple).toBe(0);
    expect(a.pulsing).toBe(false);
    expect(a.glow).toBeNull();
  });

  test("failed stays distinguishable from every other state under reduced motion", () => {
    const others = ["disconnected", "listening", "thinking", "speaking"] as const;
    const failed = markAppearance("failed", 0.9, true);
    for (const s of others) {
      expect(failed.opacity).not.toBe(markAppearance(s, 0.9, true).opacity);
    }
    expect(failed.color).toBe("var(--destructive)");
    expect(failed.ripple).toBe(0);
    expect(failed.pulsing).toBe(false);
  });
});

describe("spectrumAt", () => {
  test("the ends and the midpoint are the three stops themselves", () => {
    expect(spectrumAt(0)).toBe(VOICE_SPECTRUM[0]);
    expect(spectrumAt(0.5)).toBe(VOICE_SPECTRUM[1]);
    expect(spectrumAt(1)).toBe(VOICE_SPECTRUM[2]);
  });

  test("it reproduces the bar colours the design exported", () => {
    // Bars 8 and 15 of 28 in design/export/voice-popover.html.
    expect(spectrumAt(7 / 27)).toBe("#4e90f4");
    expect(spectrumAt(14 / 27)).toBe("#6466f1");
  });

  test("out-of-range and NaN positions stay on the ramp instead of emitting junk", () => {
    expect(spectrumAt(-1)).toBe(VOICE_SPECTRUM[0]);
    expect(spectrumAt(4)).toBe(VOICE_SPECTRUM[2]);
    expect(spectrumAt(Number.NaN)).toBe(VOICE_SPECTRUM[0]);
  });
});
