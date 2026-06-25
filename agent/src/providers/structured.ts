/**
 * Structured-output support for providers WITHOUT a native --json-schema flag
 * (codex, gemini, opencode). We append a strict "reply with ONLY this JSON"
 * instruction to the prompt and parse the model's reply by extracting the first
 * balanced JSON object. runModel handles the ONE reprompt on parse failure; this
 * module is pure (no IO) so it can be unit-tested in isolation.
 */

/** The instruction appended to the prompt to force schema-shaped JSON-only output. */
export function structuredInstruction(jsonSchema: string): string {
  return [
    "Reply with ONLY a single JSON object that conforms to this JSON Schema.",
    "No prose, no markdown, no code fences — just the raw JSON object on its own.",
    "",
    "JSON Schema:",
    jsonSchema,
  ].join("\n");
}

/**
 * Extract the first balanced JSON object from free-text output. Tolerates leading
 * prose and ```json fences (strips a fence, then scans the first "{" to the last
 * "}"). Returns null on anything unparseable so the caller can reprompt/fail closed
 * rather than throwing. Mirrors extractJsonObject in agent/src/claude.ts but
 * non-throwing.
 */
export function extractJsonObjectLoose(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  // Strip a surrounding/embedded ```json … ``` fence if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) text = fence[1].trim();

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Fall back to the substring from the first "{" to the last "}".
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
