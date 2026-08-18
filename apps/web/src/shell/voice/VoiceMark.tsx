/**
 * The voice mark: three concentric wavy circles over a soft halo, animated
 * from the assistant state. Pure presentational; `level` is 0..1 (mic while
 * listening, agent output while speaking) and drives the ripple scale.
 */
import { useEffect, useState } from "react";
import type { AgentState } from "@livekit/components-react";

/**
 * Cyan → indigo → violet. Held as hex rather than CSS variables because the
 * waveform interpolates between the stops, which var() cannot do. The mark's
 * live states key off the same three, so the header icon and the waveform
 * read as one instrument. The first stop is --accent-primary.
 */
export const VOICE_SPECTRUM = ["#38bdf8", "#6366f1", "#8b5cf6"] as const;

export type VoiceVisualState = "disconnected" | "listening" | "thinking" | "speaking" | "failed";

/**
 * Speech rarely drives the track-volume hooks past ~0.3, so an ungained level
 * moves the rings by a fraction of a pixel and the mark reads as frozen.
 * Shared with the popover waveform so both instruments saturate together.
 */
export const VOICE_LEVEL_GAIN = 2.6;

/** What the worker has said about itself on rigel.agent.state, and whether the
 * wait for it to say anything at all has run out. */
export interface AgentReport {
  state: AgentState | null;
  timedOut: boolean;
}

/**
 * The agent's own report wins. useVoiceAssistant is the fallback, and its
 * "connecting" cannot be taken at face value: that is equally what it says when
 * it cannot find the agent participant, which is not a condition it ever
 * reports leaving. Past the timeout, stop pretending.
 */
export function effectiveAgentState(report: AgentReport, hookState: AgentState): AgentState {
  if (report.state) return report.state;
  if (report.timedOut && (hookState === "connecting" || hookState === "disconnected")) return "failed";
  return hookState;
}

export interface MarkAppearance {
  color: string;
  opacity: number;
  /** 0..1 ripple coupling. Always 0 when there is nothing to couple to. */
  ripple: number;
  /** Drives the rigel-voice-pulse keyframe. */
  pulsing: boolean;
  /**
   * Radial gradient painted behind the rings, or null on the states where
   * nothing is happening, so a still mark never glows.
   */
  glow: string | null;
}

function channel(hex: string, i: number): number {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

function mix(from: string, to: string, t: number): string {
  const parts = [0, 1, 2].map((i) => {
    const v = Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t);
    return v.toString(16).padStart(2, "0");
  });
  return `#${parts.join("")}`;
}

/** Position 0..1 along the spectrum, with the indigo stop at the midpoint. */
export function spectrumAt(t: number): string {
  const [low, mid, high] = VOICE_SPECTRUM;
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  return clamped <= 0.5 ? mix(low, mid, clamped * 2) : mix(mid, high, (clamped - 0.5) * 2);
}

/** `alpha` is the two-hex-digit suffix; `color` must be a 6-digit hex. */
export function voiceHalo(color: string, alpha: string): string {
  return `radial-gradient(ellipse 50% 50% at 50% 50%, ${color}${alpha} 0%, ${color}00 100%)`;
}

const MARK_GLOW_ALPHA = "55";

export function wavyCircle(cx: number, cy: number, r: number, waves = 6, amp = 0.5): string {
  const steps = 48;
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const rr = r + Math.sin(t * waves) * amp;
    parts.push(
      `${i === 0 ? "M" : "L"}${(cx + Math.cos(t) * rr).toFixed(3)} ${(cy + Math.sin(t) * rr).toFixed(3)}`,
    );
  }
  return parts.join(" ") + " Z";
}

/** The room owns "is there a session at all"; the agent owns what it is doing
 * inside one. A connected room with no agent yet is still listening, because
 * the mic is published and transcribing. */
export function visualStateFor(agentState: AgentState | undefined, connected: boolean): VoiceVisualState {
  if (!connected) return "disconnected";
  switch (agentState) {
    case undefined:
    case "disconnected":
    case "connecting":
    case "pre-connect-buffering":
    case "initializing":
    case "idle":
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "failed":
      return "failed";
    default: {
      const exhaustive: never = agentState;
      return exhaustive;
    }
  }
}

const STATE_COLOR: Record<VoiceVisualState, string> = {
  disconnected: "var(--fg-tertiary)",
  listening: VOICE_SPECTRUM[0],
  thinking: VOICE_SPECTRUM[1],
  speaking: VOICE_SPECTRUM[2],
  failed: "var(--destructive)",
};

const STATE_GLOW: Record<VoiceVisualState, string | null> = {
  disconnected: null,
  listening: voiceHalo(VOICE_SPECTRUM[0], MARK_GLOW_ALPHA),
  thinking: voiceHalo(VOICE_SPECTRUM[1], MARK_GLOW_ALPHA),
  speaking: voiceHalo(VOICE_SPECTRUM[2], MARK_GLOW_ALPHA),
  failed: null,
};

const REDUCED_MOTION_OPACITY: Record<VoiceVisualState, number> = {
  disconnected: 1,
  listening: 0.7,
  thinking: 0.45,
  speaking: 1,
  failed: 0.55,
};

export function markAppearance(
  state: VoiceVisualState,
  level: number,
  reducedMotion: boolean,
): MarkAppearance {
  const color = STATE_COLOR[state];
  // The halo is colour, not motion, so it survives the reduced-motion path and
  // keeps carrying the state once the ripple and the pulse are gone.
  const glow = STATE_GLOW[state];
  if (reducedMotion) {
    return { color, glow, opacity: REDUCED_MOTION_OPACITY[state], ripple: 0, pulsing: false };
  }
  const coupled = state === "listening" || state === "speaking";
  const ripple = coupled && Number.isFinite(level) ? Math.min(1, Math.max(0, level * VOICE_LEVEL_GAIN)) : 0;
  return { color, glow, opacity: 1, ripple, pulsing: state === "thinking" };
}

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

export function usePrefersReducedMotion(): boolean {
  // Read on the first render, not in an effect: an effect would let one
  // animated frame through before it corrects itself.
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false);
  useEffect(() => {
    const mq = reducedMotionQuery();
    if (!mq) return;
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

const RADII = [4, 7.5, 11];
const MARK_PX = 18;
/** 60px of halo around a 44px mark in the design. */
const GLOW_INSET = "-18.2%";

export function VoiceMark({ state, level }: { state: VoiceVisualState; level: number }) {
  const reducedMotion = usePrefersReducedMotion();
  const { color, opacity, ripple, pulsing, glow } = markAppearance(state, level, reducedMotion);
  return (
    <span
      aria-hidden
      className="relative inline-flex shrink-0"
      style={{
        width: MARK_PX,
        height: MARK_PX,
        opacity,
        animation: pulsing ? "rigel-voice-pulse 1.6s ease-in-out infinite" : undefined,
      }}
    >
      {glow && (
        <span
          className="pointer-events-none absolute rounded-full"
          style={{ inset: GLOW_INSET, backgroundImage: glow }}
        />
      )}
      <svg
        viewBox="-2 -2 28 28"
        width={MARK_PX}
        height={MARK_PX}
        data-voice-state={state}
        className="relative"
        style={{ color }}
      >
        {RADII.map((r, i) => (
          <path
            key={r}
            d={wavyCircle(12, 12, r)}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            style={{
              transform: `scale(${1 + ripple * 0.05 * (i + 1)})`,
              transformOrigin: "center",
              transition: reducedMotion ? undefined : "transform 80ms linear",
            }}
          />
        ))}
      </svg>
    </span>
  );
}
