/**
 * Turns the assistant's remediation notifications into a warm, secretary-style
 * voice while keeping the checkmark-list layout. Two pure helpers, no I/O:
 *
 *  - `greeting` picks a natural lead-in from what's in the batch (things done vs
 *    things waiting on the operator's OK).
 *  - `conjugateDone` / `couldntPhrase` shape a single line's verb off the action's
 *    known kind, so a done line reads past-tense ("Restarted …") and a failed one
 *    reads "Couldn't restart …" without the model having to guess the tense.
 */

/** kind → [base imperative verb, past-tense form]. Drives the line voice. */
const VERB: Record<string, [string, string]> = {
  restart: ["Restart", "Restarted"],
  scale: ["Scale", "Scaled"],
  rollback: ["Roll back", "Rolled back"],
  setEnv: ["Update", "Updated"],
  deletePod: ["Delete", "Deleted"],
  cordon: ["Cordon", "Cordoned"],
  uncordon: ["Uncordon", "Uncordoned"],
  openFixPR: ["Open", "Opened"],
};

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

/**
 * Past-tense a done line off the action's kind. When the label starts with the
 * kind's base verb (e.g. "Restart backend-worker …") it becomes past ("Restarted
 * backend-worker …"). Anything unexpected falls back to the label unchanged, so a
 * done line is never mangled.
 */
export function conjugateDone(kind: string, label: string): string {
  const v = VERB[kind];
  if (!v) return label;
  const [imp, past] = v;
  const trimmed = label.trimStart();
  if (trimmed.toLowerCase().startsWith(imp.toLowerCase())) {
    const after = trimmed.slice(imp.length);
    if (after === "" || /^\s/.test(after)) return past + after;
  }
  return label;
}

/** "Couldn't restart backend-worker …" for a failed action. */
export function couldntPhrase(label: string): string {
  return `Couldn't ${lowerFirst(label)}`;
}

/**
 * Pick a lead-in for the whole batch from the markers present:
 *   ✓ / ✗ = something handled, ▸ = something waiting on the operator's OK.
 */
export function greeting(lines: string[]): string {
  const success = lines.filter((l) => l.startsWith("✓")).length;
  const failure = lines.filter((l) => l.startsWith("✗")).length;
  const pending = lines.filter((l) => l.startsWith("▸")).length;
  if ((success > 0 || failure > 0) && pending > 0) {
    return "Here's what I handled, plus a couple things I'd like your OK on:";
  }
  if (pending > 0) {
    return pending === 1
      ? "One thing I'd like to run past you:"
      : "A couple things I'd like to run past you:";
  }
  if (success > 0 && failure > 0) return "Here's what I've been up to:";
  if (failure > 0) {
    return failure === 1 ? "Ran into a snag on this one:" : "Ran into a couple snags:";
  }
  if (success > 0) return "Here's what I took care of:";
  return "Quick update from the cluster:";
}
