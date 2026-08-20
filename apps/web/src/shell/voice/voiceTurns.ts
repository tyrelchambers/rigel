/** Turn segmentation for a voice session's transcript. */
export interface VoiceSegment {
  id: string;
  text: string;
  fromAgent: boolean;
}

/**
 * One entry per TURN, not per transcription segment. Deepgram finalizes a
 * spoken sentence in several segments and the agent streams its answer a
 * phrase at a time, so mapping segments straight through turned "can you
 * update my canada hires deployment labels" into three separate bubbles.
 * Consecutive segments from the same speaker merge, keeping the first id so a
 * bubble already rendered is not remounted as its tail arrives.
 */
export function mergeSegments(segments: VoiceSegment[]): VoiceSegment[] {
  const turns: VoiceSegment[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.fromAgent === segment.fromAgent) {
      last.text = `${last.text} ${text}`;
      continue;
    }
    turns.push({ ...segment, text });
  }
  return turns;
}
