/**
 * The command box. One implementation for every surface that shows an operator
 * the exact kubectl before it runs: the ConfirmSheet they approve it in, and
 * the voice popover that raised it. If these two ever look different, the
 * operator has to learn the same thing twice.
 */
import type { ReactNode } from "react";

/**
 * Renders a shell command with light syntax emphasis: the binary in the accent
 * color, flags dimmed, everything else in the foreground. Whitespace is
 * preserved so the `pre` still wraps/breaks naturally.
 */
export function HighlightedCommand({ command, accent }: { command: string; accent: string }) {
  const parts = command.split(/(\s+)/);
  let sawBinary = false;
  return (
    <>
      {parts.map((tok, i) => {
        if (/^\s+$/.test(tok) || tok === "") return <span key={i}>{tok}</span>;
        if (!sawBinary) {
          sawBinary = true;
          return (
            <span key={i} style={{ color: accent }} className="font-medium">
              {tok}
            </span>
          );
        }
        if (tok.startsWith("-"))
          return (
            <span key={i} className="text-muted-foreground">
              {tok}
            </span>
          );
        return (
          <span key={i} className="text-foreground/90">
            {tok}
          </span>
        );
      })}
    </>
  );
}

export function CommandBlock({
  command,
  accent,
  trailing,
  compact = false,
}: {
  command: string;
  accent: string;
  /** Absolutely positioned top-right, e.g. a copy button. Reserves space in the pre. */
  trailing?: ReactNode;
  /** Tighter type and padding, for the popover's narrower card. */
  compact?: boolean;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-xl"
      style={{ background: "#08080A", border: "1px solid #26272B" }}
    >
      {trailing}
      <pre
        className={`overflow-x-auto font-mono whitespace-pre-wrap break-all ${
          compact ? "px-3 py-2.5 text-2xs leading-5" : "px-4 py-3.5 text-xs leading-6"
        } ${trailing ? "pr-16" : ""}`}
      >
        <span className="select-none font-semibold" style={{ color: accent }}>
          ${" "}
        </span>
        <HighlightedCommand command={command} accent={accent} />
      </pre>
    </div>
  );
}
