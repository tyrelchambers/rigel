/**
 * SplashScreen — the Rigel boot screen.
 *
 * The comet draws the constellation once, the "RIGEL" wordmark resolves and
 * holds, then the whole overlay fades out and `onFinish` fires so the host can
 * unmount it and reveal the app. Dark-only, matching the app surface. Respects
 * prefers-reduced-motion (RigelMark renders static and completes immediately).
 */
import { useEffect, useRef, useState } from "react";
import { RigelMark } from "@/components/RigelMark";

const HOLD_MS = 700; // how long "RIGEL" lingers after the mark lands
const FADE_MS = 500; // overlay fade-out

export function SplashScreen({ onFinish }: { onFinish?: () => void }) {
  const [wordIn, setWordIn] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const mounted = useRef(true);
  const done = useRef(false);

  useEffect(() => {
    // Reveal the wordmark as the comet reaches the apex (~CHARGE + TRAVEL into the draw).
    const t = setTimeout(() => mounted.current && setWordIn(true), 940);
    return () => {
      mounted.current = false;
      clearTimeout(t);
    };
  }, []);

  const handleDrawn = () => {
    if (!mounted.current) return;
    setWordIn(true);
    setTimeout(() => mounted.current && setLeaving(true), HOLD_MS);
  };

  const handleTransitionEnd = (e: React.TransitionEvent) => {
    if (e.target === e.currentTarget && e.propertyName === "opacity" && leaving && !done.current) {
      done.current = true;
      onFinish?.();
    }
  };

  return (
    <div
      onTransitionEnd={handleTransitionEnd}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 30,
        background: "var(--surface-primary)",
        opacity: leaving ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
        pointerEvents: leaving ? "none" : "auto",
      }}
    >
      <RigelMark
        size={140}
        loading
        loop={false}
        glow={false}
        color="#ffffff"
        coreColor="#ffffff"
        onComplete={handleDrawn}
      />
      <div
        style={{
          fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif',
          textTransform: "uppercase",
          fontWeight: 900,
          color: "var(--fg-primary)",
          fontSize: "clamp(22px, 4vw, 38px)",
          // letter-spacing pushes glyphs right; pad an equal amount left to keep it centered.
          letterSpacing: wordIn ? "0.3em" : "0.48em",
          paddingLeft: wordIn ? "0.3em" : "0.48em",
          opacity: wordIn ? 1 : 0,
          transform: wordIn ? "translateY(0)" : "translateY(8px)",
          transition: "opacity 600ms ease, letter-spacing 800ms ease, transform 800ms ease, padding-left 800ms ease",
        }}
      >
        Rigel
      </div>
    </div>
  );
}
