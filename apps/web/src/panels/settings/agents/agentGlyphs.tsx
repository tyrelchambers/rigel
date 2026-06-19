// Small monochrome vendor glyphs (currentColor). Intentionally simple — brand-
// accurate marks can replace these later. Falls back to a generic bot.
import { Bot } from "lucide-react";
import type { AgentId } from "@/lib/api";

export function AgentGlyph({ id, size = 22 }: { id: AgentId; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none" as const };
  switch (id) {
    case "claude": // Anthropic-ish burst
      return (
        <svg {...common} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
          {Array.from({ length: 8 }).map((_, i) => {
            const a = (i * Math.PI) / 4;
            return <line key={i} x1={12} y1={12} x2={12 + 8 * Math.cos(a)} y2={12 + 8 * Math.sin(a)} />;
          })}
        </svg>
      );
    case "codex": // OpenAI-ish ring
      return (
        <svg {...common} stroke="currentColor" strokeWidth={1.8}>
          <circle cx={12} cy={12} r={7} />
          <circle cx={12} cy={12} r={2.5} fill="currentColor" stroke="none" />
        </svg>
      );
    case "gemini": // four-point spark
      return (
        <svg {...common} fill="currentColor">
          <path d="M12 2c.6 4.4 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8z" />
        </svg>
      );
    default:
      return <Bot size={size} />;
  }
}
