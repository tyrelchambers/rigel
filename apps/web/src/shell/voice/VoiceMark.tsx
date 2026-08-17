/**
 * The voice mark: three concentric wavy circles, animated from the assistant
 * state. Pure presentational; `level` is 0..1 (mic while listening, agent
 * output while speaking) and drives the ripple scale.
 */
import { useEffect, useState } from "react";

export type VoiceVisualState = "disconnected" | "listening" | "thinking" | "speaking";

export interface MarkAppearance {
  color: string;
  opacity: number;
  /** 0..1 ripple coupling. Always 0 when there is nothing to couple to. */
  ripple: number;
  /** Drives the rigel-voice-pulse keyframe. */
  pulsing: boolean;
}

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
export function visualStateFor(agentState: string | undefined, connected: boolean): VoiceVisualState {
  if (!connected) return "disconnected";
  if (agentState === "thinking") return "thinking";
  if (agentState === "speaking") return "speaking";
  return "listening";
}

const REDUCED_MOTION_OPACITY: Record<VoiceVisualState, number> = {
  disconnected: 1,
  listening: 0.7,
  thinking: 0.45,
  speaking: 1,
};

export function markAppearance(
  state: VoiceVisualState,
  level: number,
  reducedMotion: boolean,
): MarkAppearance {
  const color = state === "disconnected" ? "var(--fg-tertiary)" : "var(--accent-primary)";
  if (reducedMotion) {
    return { color, opacity: REDUCED_MOTION_OPACITY[state], ripple: 0, pulsing: false };
  }
  const coupled = state === "listening" || state === "speaking";
  const ripple = coupled && Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return { color, opacity: 1, ripple, pulsing: state === "thinking" };
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

export function VoiceMark({ state, level }: { state: VoiceVisualState; level: number }) {
  const reducedMotion = usePrefersReducedMotion();
  const { color, opacity, ripple, pulsing } = markAppearance(state, level, reducedMotion);
  return (
    <svg
      viewBox="-2 -2 28 28"
      width={18}
      height={18}
      aria-hidden
      data-voice-state={state}
      style={{
        color,
        opacity,
        animation: pulsing ? "rigel-voice-pulse 1.6s ease-in-out infinite" : undefined,
      }}
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
  );
}
