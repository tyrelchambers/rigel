export type AnnotationValue =
  | { kind: "plain"; text: string }
  | { kind: "json"; data: unknown; preview: string };

/** Detect whether a raw label/annotation value is a JSON object or array worth structured rendering. */
export function parseAnnotationValue(raw: string): AnnotationValue {
  try {
    const data = JSON.parse(raw);
    if (data !== null && typeof data === "object") {
      return { kind: "json", data, preview: JSON.stringify(data) };
    }
  } catch {
    /* not JSON */
  }
  return { kind: "plain", text: raw };
}
