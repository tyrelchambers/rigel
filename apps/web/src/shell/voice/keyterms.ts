import type { MentionCandidate, MentionKind } from "@/panels/chat/mentions";

/**
 * Bounds the data frame, which LiveKit caps at 15KB. The worker applies its
 * own, smaller cap once the static vocabulary is folded in.
 */
export const MAX_VOICE_KEYTERMS = 50;

/** Pod names carry generated hash suffixes, so they are the least likely to be spoken. */
const SPOKEN_ORDER: MentionKind[] = ["deployment", "node", "pod"];

export function voiceKeytermNames(candidates: readonly MentionCandidate[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const kind of SPOKEN_ORDER) {
    for (const c of candidates) {
      if (c.kind !== kind) continue;
      const name = c.name.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push(name);
      if (out.length === MAX_VOICE_KEYTERMS) return out;
    }
  }
  return out;
}
