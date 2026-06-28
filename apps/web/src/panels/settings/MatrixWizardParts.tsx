// Presentational building blocks for the Matrix connect wizard + section, built
// to reproduce the Pencil "Matrix Wizard" frames (clankerlocal.pen) screen for
// screen. Colors map to the app's design tokens (var(--surface-*), --accent-*,
// --status-*); the handful of bespoke greys the design uses verbatim (#8C8C95
// sub, #9A9AA2 label, #6E6E77 caption, #C9C9CF step) match modal.tsx's palette.
import { useId, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { XIcon } from "lucide-react";

// ── shared design values ────────────────────────────────────────────────────
export const SUB = "#8C8C95"; // secondary body text
export const LABEL = "#9A9AA2"; // field labels
export const CAPTION = "#6E6E77"; // mono captions / tertiary
export const STEP_TXT = "#C9C9CF"; // numbered-step text
const HAIRLINE = "rgba(255,255,255,0.07)"; // ≈ #FFFFFF12
const DIVIDER = "rgba(255,255,255,0.05)"; // ≈ #FFFFFF0A

type Tone = "neutral" | "green" | "red" | "accent" | "amber";

const TILE_TONE: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: "rgba(255,255,255,0.07)", fg: "#FFFFFF" },
  green: { bg: "rgba(16,185,129,0.12)", fg: "var(--status-running)" },
  red: { bg: "rgba(239,68,68,0.12)", fg: "var(--status-failed)" },
  accent: { bg: "var(--accent-dim)", fg: "var(--accent-primary)" },
  amber: { bg: "rgba(245,158,11,0.12)", fg: "var(--status-pending)" },
};

/** Rounded icon tile (modal header glyph, section status glyph). */
export function IconTile({
  tone = "neutral",
  size = 32,
  radius = 8,
  children,
}: {
  tone?: Tone;
  size?: number;
  radius?: number;
  children: ReactNode;
}) {
  const t = TILE_TONE[tone];
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, borderRadius: radius, background: t.bg, color: t.fg }}
    >
      {children}
    </div>
  );
}

/** Header stepper: small accent bars + a mono "Step N of 3" caption. */
export function Stepper({ step, total = 3 }: { step: number; total?: number }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className="h-1 w-[22px] rounded-[2px]"
            style={{ background: i < step ? "var(--accent-primary)" : "rgba(255,255,255,0.12)" }}
          />
        ))}
      </div>
      <span
        className="font-mono"
        style={{ fontSize: 10.5, letterSpacing: 0.8, color: CAPTION }}
      >
        {step === 1 ? "Step 1" : `Step ${step} of ${total}`}
      </span>
    </div>
  );
}

/**
 * The wizard modal chrome (Pencil "Modal Shell"): an optional top progress bar,
 * a hairline-separated header (icon tile + title + optional stepper + close),
 * a scrolling body, and a footer. Built on the shared Dialog primitive.
 */
export function WizardShell({
  open,
  onOpenChange,
  title,
  icon,
  iconTone = "neutral",
  progress,
  step,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  icon: ReactNode;
  iconTone?: Tone;
  /** 0..1 — renders the thin top progress bar when provided. */
  progress?: number;
  /** Current 1-based step — renders the header stepper when provided. */
  step?: number;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex w-[540px] max-w-[calc(100vw-2rem)] max-h-[84vh] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>

        {progress != null && (
          <div className="h-[3px] w-full shrink-0" style={{ background: "rgba(255,255,255,0.04)" }}>
            <div
              className="h-full transition-[width] duration-300"
              style={{ width: `${Math.round(progress * 100)}%`, background: "var(--accent-primary)" }}
            />
          </div>
        )}

        <div
          className="flex shrink-0 items-center justify-between"
          style={{ padding: "16px 22px", borderBottom: `1px solid ${HAIRLINE}` }}
        >
          <div className="flex items-center gap-3">
            <IconTile tone={iconTone}>{icon}</IconTile>
            <div className="flex flex-col gap-[5px]">
              <h2 style={{ fontSize: 18, fontWeight: 700, color: "#FFFFFF", lineHeight: 1.1 }}>{title}</h2>
              {step != null && <Stepper step={step} />}
            </div>
          </div>
          <DialogClose
            className="flex shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.05]"
            style={{ width: 32, height: 32 }}
          >
            <XIcon className="size-[18px]" style={{ color: SUB }} />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && <div className="shrink-0">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}

/** Body wrapper — the design's 22px padded, 18px-gap vertical column. */
export function WizardBody({ gap = 18, children }: { gap?: number; children: ReactNode }) {
  return (
    <div className="flex flex-col" style={{ padding: 22, gap }}>
      {children}
    </div>
  );
}

/** Lead + sub intro block. */
export function WizardIntro({ lead, sub }: { lead: string; sub: string }) {
  return (
    <div className="flex flex-col gap-[5px]">
      <span style={{ fontSize: 15, fontWeight: 600, color: "#FFFFFF" }}>{lead}</span>
      <span style={{ fontSize: 13, color: SUB, lineHeight: 1.5 }}>{sub}</span>
    </div>
  );
}

/** Labeled sunken input with an optional trailing icon and hint line. */
export function WizardInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  mono = true,
  trailing,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  trailing?: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} style={{ fontSize: 12.5, fontWeight: 500, color: LABEL }}>
        {label}
      </label>
      <div
        className="flex items-center gap-2.5 rounded-lg"
        style={{ background: "var(--surface-sunken)", border: `1px solid ${HAIRLINE}`, padding: "11px 13px" }}
      >
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn(
            "min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#6E6E77]",
            mono && "font-mono",
          )}
          style={{ fontSize: 12.5, color: "#FFFFFF" }}
        />
        {trailing && <span className="shrink-0" style={{ color: CAPTION }}>{trailing}</span>}
      </div>
      {hint && <span style={{ fontSize: 11.5, color: CAPTION }}>{hint}</span>}
    </div>
  );
}

const OPTION_TONE: Record<"green" | "accent" | "amber", string> = {
  green: "var(--status-running)",
  accent: "var(--accent-primary)",
  amber: "var(--status-pending)",
};
const OPTION_TINT: Record<"green" | "accent" | "amber", string> = {
  green: "rgba(16,185,129,0.12)",
  accent: "var(--accent-dim)",
  amber: "rgba(245,158,11,0.12)",
};

/** Step-1 option card (icon tile + tag eyebrow + title + desc + chevron). */
export function OptionCard({
  tone,
  tag,
  title,
  desc,
  icon,
  selected,
  disabled,
  badge,
  onClick,
}: {
  tone: "green" | "accent" | "amber";
  tag: string;
  title: string;
  desc: string;
  icon: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  badge?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3.5 rounded-[14px] text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-55" : "hover:bg-white/[0.03]",
      )}
      style={{
        background: "#18181B",
        border: selected ? "1px solid var(--accent-primary)" : "1px solid rgba(255,255,255,0.08)",
        boxShadow: selected ? "0 0 0 1px var(--accent-primary)" : undefined,
        padding: 16,
      }}
    >
      <div
        className="flex shrink-0 items-center justify-center rounded-[10px]"
        style={{ width: 40, height: 40, background: OPTION_TINT[tone], color: OPTION_TONE[tone] }}
      >
        {icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span
          className="self-start rounded-full font-mono"
          style={{
            fontSize: 9.5,
            letterSpacing: 0.6,
            color: OPTION_TONE[tone],
            background: OPTION_TINT[tone],
            padding: "3px 8px",
          }}
        >
          {tag}
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, color: "#FFFFFF" }}>{title}</span>
        <span style={{ fontSize: 12.5, color: SUB, lineHeight: 1.4 }}>{desc}</span>
        {badge}
      </div>
      <ChevronRight className="size-[18px] shrink-0" style={{ color: CAPTION }} />
    </button>
  );
}

/** Full-width segmented control (Bot sign-in: Paste access token | Log in). */
export function SegmentedToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; icon: ReactNode }[];
}) {
  return (
    <div
      className="flex w-full gap-1 rounded-[9px] p-[3px]"
      style={{ background: "var(--surface-sunken)", border: `1px solid ${HAIRLINE}` }}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-[7px] transition-colors"
            style={{
              padding: "8px 0",
              background: active ? "rgba(255,255,255,0.07)" : "transparent",
              color: active ? "#FFFFFF" : SUB,
              fontSize: 12.5,
              fontWeight: 500,
            }}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Green pill toggle (two-way replies / channel enabled). */
export function GreenToggle({
  on,
  onClick,
  disabled,
  label,
}: {
  on: boolean;
  onClick?: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="relative inline-flex items-center rounded-full transition-colors disabled:opacity-50"
      style={{
        width: 40,
        height: 24,
        padding: 3,
        justifyContent: on ? "flex-end" : "flex-start",
        background: on ? "var(--status-running)" : "rgba(255,255,255,0.15)",
      }}
    >
      <span className="block rounded-full bg-white" style={{ width: 18, height: 18 }} />
    </button>
  );
}

// ── footer buttons ──────────────────────────────────────────────────────────

/** Secondary footer button (Back / Cancel / Send a test). */
export function BackButton({
  label = "Back",
  icon,
  chevron = true,
  onClick,
  disabled,
}: {
  label?: string;
  icon?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded-[9px] transition-colors hover:bg-white/[0.04] disabled:opacity-50"
      style={{ padding: "10px 12px", color: SUB, fontSize: 13.5, fontWeight: 500 }}
    >
      {icon ?? (chevron && <ChevronLeft className="size-[15px]" />)}
      {label}
    </button>
  );
}

/** Accent primary footer button (Continue / Finish / Done / Retry). */
export function PrimaryButton({
  label,
  icon,
  onClick,
  disabled,
  busy,
  busyLabel = "Connecting…",
}: {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-disabled={disabled || busy}
      className="flex items-center justify-center gap-2 rounded-[9px] transition-opacity disabled:opacity-50"
      style={{ background: "var(--accent-primary)", color: "#0A0A0A", padding: "11px 18px", fontSize: 14, fontWeight: 600 }}
    >
      {busy ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          {busyLabel}
        </>
      ) : (
        <>
          {label}
          {icon}
        </>
      )}
    </button>
  );
}

/** Footer row — left (back/secondary) + right (primary), space-between. */
export function WizardFooter({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: "10px 22px 18px" }}>
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}

export { HAIRLINE, DIVIDER };
