// Vendor glyphs — the lucide marks used in the Pencil design. Monochrome
// (currentColor); brand-accurate marks can replace these later.
import { Asterisk, Sparkles, Target, Bot, type LucideIcon } from "lucide-react";
import type { AgentId } from "@/lib/api";

const GLYPH: Record<AgentId, LucideIcon> = {
  claude: Asterisk,
  codex: Sparkles,
  gemini: Target,
  opencode: Bot,
};

export function AgentGlyph({ id, size = 22 }: { id: AgentId; size?: number }) {
  const Icon = GLYPH[id] ?? Bot;
  return <Icon size={size} />;
}
