/**
 * RigelMark — the Rigel constellation logo, inline.
 *
 * Source of truth: /assets/brand/logo-constellation.svg. That file fills with
 * dark navy (#0B1F3A), which is invisible on the app's dark surfaces, so this
 * draws stroke/fill with `currentColor` and lets the parent set the color.
 *
 * Pass `loading` to play the "Comet Draw" animation: white-hot heads leave the
 * bottom-left star, draw every constellation line, and converge on the top-right
 * star, which blooms. `loop` (default true) makes it an indeterminate loader;
 * `loop={false}` plays the reveal once (e.g. a splash) then rests as the logo
 * and calls `onComplete`.
 *
 * Colors: by default everything inherits `currentColor` (back-compatible). For
 * the animation, pass `color` (the comet/line color) and `coreColor` (the hot
 * head). On dark surfaces use the cyan accent + white core; on light surfaces
 * use a graphite pair.
 */
import { useEffect, useId, useRef, type CSSProperties } from "react";

// --- constellation geometry (from the brand SVG, viewBox 0 0 132 132) ---
const STARS: Record<string, [number, number]> = {
  s1: [30, 46], // top-left
  s2: [98, 30], // top-right  ← convergence / flare
  s3: [102, 96], // bottom-right
  s4: [42, 102], // bottom-left ← pulse origin
};
const ORIGIN = "s4";
const FINAL = "s2";

// Three routes leave the origin and all converge on the final star; together
// they cover every one of the five constellation lines exactly once.
const ROUTE_NODES = [
  ["s4", "s1", "s2"], // up the left edge, across the top
  ["s4", "s2"], // straight diagonal
  ["s4", "s3", "s2"], // along the bottom, up the right edge
];

type Seg = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  len: number;
  cstart: number; // distance from the route's origin to this segment's start
  routeIdx: number;
  mid: string; // the node this segment ends on
};
type Route = { segs: Seg[]; total: number };

const ROUTES: Route[] = ROUTE_NODES.map((nodes, routeIdx) => {
  const segs: Seg[] = [];
  let cum = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = STARS[nodes[i]];
    const b = STARS[nodes[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], len, cstart: cum, routeIdx, mid: nodes[i + 1] });
    cum += len;
  }
  return { segs, total: cum };
});
const SEGMENTS: Seg[] = ROUTES.flatMap((r) => r.segs);

function pointOnRoute(r: Route, d: number): [number, number] {
  const dd = Math.max(0, Math.min(d, r.total));
  for (const s of r.segs) {
    if (dd <= s.cstart + s.len) {
      const t = (dd - s.cstart) / s.len;
      return [s.x1 + (s.x2 - s.x1) * t, s.y1 + (s.y2 - s.y1) * t];
    }
  }
  const last = r.segs[r.segs.length - 1];
  return [last.x2, last.y2];
}

// --- timing (ms) & easing ---
const CHARGE = 240;
const TRAVEL = 700;
const BLOOM = 380;
const HOLD = 420;
const GAP = 260; // loop-only fade-out before the next draw
const LOOP_DUR = CHARGE + TRAVEL + BLOOM + HOLD + GAP;
const ONCE_DUR = CHARGE + TRAVEL + BLOOM + HOLD;

const TRAIL_DOTS = 9;
const TRAIL_SPACING = 4.0;
const HEAD_R = 3.6;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export function RigelMark({
  size = 15,
  style,
  className,
  loading = false,
  loop = true,
  speed = 1,
  color,
  coreColor,
  glow = true,
  onComplete,
}: {
  size?: number;
  style?: CSSProperties;
  className?: string;
  /** Play the Comet Draw animation. */
  loading?: boolean;
  /** Loop continuously (loader) vs play once then settle as the logo (intro). */
  loop?: boolean;
  /** Animation speed multiplier. */
  speed?: number;
  /** Comet/line color. Defaults to currentColor. Use white on dark, graphite on light. */
  color?: string;
  /** Hot comet-head color. Defaults to `color`. Use white on dark, dark graphite on light. */
  coreColor?: string;
  /** Soft bloom around stars/lines while animating. Turn off for light/graphite backgrounds. */
  glow?: boolean;
  /** Fired when a `loop={false}` animation finishes. */
  onComplete?: () => void;
}) {
  const lineRefs = useRef<(SVGLineElement | null)[]>([]);
  const starRefs = useRef<Record<string, SVGCircleElement | null>>({});
  const dotRefs = useRef<(SVGCircleElement | null)[][]>(ROUTES.map(() => []));
  const bloomRef = useRef<SVGCircleElement | null>(null);
  const ringRef = useRef<SVGCircleElement | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const rawId = useId();
  const glowId = `rigel-glow-${rawId.replace(/:/g, "")}`;

  const lineColor = color ?? "currentColor";
  const core = coreColor ?? color ?? "currentColor";

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const setRest = () => {
      // Fully-drawn logo at rest: lines complete, stars lit, no comet/bloom.
      for (const ln of lineRefs.current) {
        if (!ln) continue;
        ln.style.strokeDasharray = "";
        ln.style.opacity = "1";
      }
      for (const k in starRefs.current) {
        const c = starRefs.current[k];
        if (!c) continue;
        c.style.opacity = "1";
        c.setAttribute("r", "7");
      }
      for (const route of dotRefs.current) for (const d of route) if (d) d.style.opacity = "0";
      if (bloomRef.current) bloomRef.current.style.opacity = "0";
      if (ringRef.current) ringRef.current.style.opacity = "0";
    };

    if (!loading || reduce) {
      setRest();
      if (loading && reduce && !loop) onCompleteRef.current?.();
      return;
    }

    const setFrame = (t: number) => {
      const C = CHARGE;
      const T = C + TRAVEL;
      const B = T + BLOOM;
      const H = B + HOLD;
      let phase: number;
      let lp: number;
      if (t < C) {
        phase = 0;
        lp = t / CHARGE;
      } else if (t < T) {
        phase = 1;
        lp = (t - C) / TRAVEL;
      } else if (t < B) {
        phase = 2;
        lp = (t - T) / BLOOM;
      } else if (t < H) {
        phase = 3;
        lp = (t - B) / HOLD;
      } else {
        phase = 4;
        lp = (t - H) / GAP;
      }

      const g = phase < 1 ? 0 : phase === 1 ? easeInOutCubic(lp) : 1;
      const fade = phase === 4 ? 1 - easeOutCubic(lp) : 1; // dissolve before the loop restarts

      // lines: reveal as the comet head passes
      SEGMENTS.forEach((s, i) => {
        const ln = lineRefs.current[i];
        if (!ln) return;
        const head = g * ROUTES[s.routeIdx].total;
        const d = clamp(head - s.cstart, 0, s.len);
        ln.style.strokeDasharray = `${d.toFixed(2)} ${(s.len + 1).toFixed(2)}`;
        ln.style.opacity = fade.toFixed(3);
      });

      // origin star: charges first, stays lit through the draw
      const origin = starRefs.current[ORIGIN];
      if (origin) {
        let e: number;
        let sc: number;
        if (phase === 0) {
          e = easeOutCubic(lp);
          sc = 1 + 0.55 * Math.sin(lp * Math.PI);
        } else if (phase === 4) {
          e = 1 - easeOutCubic(lp);
          sc = 1;
        } else {
          e = 1;
          sc = phase === 1 ? 1 + 0.1 * (1 - g) : 1;
        }
        origin.style.opacity = clamp(e, 0, 1).toFixed(3);
        origin.setAttribute("r", (7 * sc).toFixed(2));
      }

      // intermediate stars: change colour (dim → lit) as the head passes — no size change
      for (const node of ["s1", "s3"]) {
        const c = starRefs.current[node];
        if (!c) continue;
        const seg = SEGMENTS.find((s) => s.mid === node);
        let e = 0;
        if (seg) {
          const at = seg.cstart + seg.len;
          const head = g * ROUTES[seg.routeIdx].total;
          e = clamp((head - at + 5) / 6, 0, 1);
        }
        c.style.opacity = (e * fade).toFixed(3);
      }

      // final star: flares as the streams arrive
      const fin = starRefs.current[FINAL];
      if (fin) {
        let e = 0;
        let sc = 1;
        if (phase === 2) {
          e = clamp(easeOutBack(lp), 0, 1.05);
          sc = 1 + 0.7 * easeOutBack(Math.min(lp * 1.25, 1)) * (1 - lp * 0.6);
        } else if (phase === 3) {
          e = 1;
          sc = 1 + 0.12 * (1 - lp);
        } else if (phase === 4) {
          e = 1 - easeOutCubic(lp);
          sc = 1;
        }
        fin.style.opacity = clamp(e, 0, 1).toFixed(3);
        fin.setAttribute("r", (7 * sc).toFixed(2));
      }

      // comet heads + tapered trails (one per route), visible only while drawing
      ROUTES.forEach((r, ri) => {
        const head = g * r.total;
        dotRefs.current[ri].forEach((dot, i) => {
          if (!dot) return;
          const d = head - i * TRAIL_SPACING;
          if (phase !== 1 || d <= 0 || g >= 1) {
            dot.style.opacity = "0";
            return;
          }
          const [x, y] = pointOnRoute(r, d);
          const taper = 1 - i / (TRAIL_DOTS + 2);
          dot.setAttribute("cx", x.toFixed(2));
          dot.setAttribute("cy", y.toFixed(2));
          dot.setAttribute("r", Math.max(0.5, HEAD_R * taper).toFixed(2));
          dot.style.opacity = (clamp(1 - i / (TRAIL_DOTS + 1), 0, 1) * 0.95).toFixed(3);
        });
      });

      // bloom at the final star
      const [fx, fy] = STARS[FINAL];
      if (bloomRef.current) {
        if (phase === 2) {
          const e = easeOutCubic(lp);
          bloomRef.current.setAttribute("r", (7 + 16 * e).toFixed(2));
          bloomRef.current.style.opacity = ((1 - e) * 0.5).toFixed(3);
        } else {
          bloomRef.current.style.opacity = "0";
        }
        bloomRef.current.setAttribute("cx", `${fx}`);
        bloomRef.current.setAttribute("cy", `${fy}`);
      }
      if (ringRef.current) {
        if (phase === 2) {
          const e = easeOutCubic(lp);
          ringRef.current.setAttribute("r", (7 + 26 * e).toFixed(2));
          ringRef.current.style.opacity = ((1 - e) * 0.6).toFixed(3);
        } else {
          ringRef.current.style.opacity = "0";
        }
        ringRef.current.setAttribute("cx", `${fx}`);
        ringRef.current.setAttribute("cy", `${fy}`);
      }
    };

    let raf = 0;
    let startTs: number | null = null;
    const tick = (now: number) => {
      if (startTs === null) startTs = now;
      const elapsed = (now - startTs) * speed;
      if (loop) {
        setFrame(elapsed % LOOP_DUR);
        raf = requestAnimationFrame(tick);
      } else if (elapsed >= ONCE_DUR) {
        setRest(); // settle into the static logo
        onCompleteRef.current?.();
      } else {
        setFrame(elapsed);
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loading, loop, speed]);

  const animating = loading;
  const glowFilter = animating && glow ? `url(#${glowId})` : undefined;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 132 132"
      fill="none"
      className={className}
      style={{ flexShrink: 0, overflow: "visible", ...style }}
      aria-hidden
    >
      <defs>
        {/* userSpaceOnUse keeps the bloom consistent as the comet/lines move */}
        <filter id={glowId} filterUnits="userSpaceOnUse" x="-44" y="-44" width="220" height="220">
          <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="wide" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="mid" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.8" result="tight" />
          <feMerge>
            <feMergeNode in="wide" />
            <feMergeNode in="wide" />
            <feMergeNode in="mid" />
            <feMergeNode in="tight" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* constellation lines */}
      <g filter={glowFilter}>
        {SEGMENTS.map((s, i) => (
          <line
            key={i}
            ref={(n) => {
              lineRefs.current[i] = n;
            }}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke={lineColor}
            strokeWidth={4.5}
            strokeLinecap="round"
          />
        ))}
      </g>

      {/* bloom + shockwave ring at the final star */}
      <circle ref={bloomRef} fill={lineColor} opacity={0} />
      <circle ref={ringRef} fill="none" stroke={lineColor} strokeWidth={2.2} opacity={0} />

      {/* faint base for the two midpoint stars — they change colour (not size) as the pulse passes */}
      {animating &&
        ["s1", "s3"].map((k) => {
          const [cx, cy] = STARS[k];
          return <circle key={`mid-${k}`} cx={cx} cy={cy} r={7} fill={lineColor} fillOpacity={0.18} />;
        })}

      {/* stars */}
      <g filter={glowFilter}>
        {Object.entries(STARS).map(([k, [cx, cy]]) => (
          <circle
            key={k}
            ref={(n) => {
              starRefs.current[k] = n;
            }}
            cx={cx}
            cy={cy}
            r={7}
            fill={lineColor}
          />
        ))}
      </g>

      {/* comet heads + trails */}
      <g filter={glowFilter}>
        {ROUTES.map((_, ri) =>
          Array.from({ length: TRAIL_DOTS + 1 }, (_, i) => (
            <circle
              key={`${ri}-${i}`}
              ref={(n) => {
                dotRefs.current[ri][i] = n;
              }}
              r={HEAD_R}
              fill={i < 2 ? core : lineColor}
              opacity={0}
            />
          )),
        )}
      </g>
    </svg>
  );
}
