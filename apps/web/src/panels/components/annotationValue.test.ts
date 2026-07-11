import { describe, it, expect } from "vitest";
import { parseAnnotationValue } from "./annotationValue";

describe("parseAnnotationValue", () => {
  it("detects a JSON object", () => {
    expect(parseAnnotationValue('{"a":1}')).toEqual({ kind: "json", data: { a: 1 }, preview: '{"a":1}' });
  });

  it("detects a JSON array", () => {
    expect(parseAnnotationValue("[1,2]")).toEqual({ kind: "json", data: [1, 2], preview: "[1,2]" });
  });

  it("treats plain text as plain", () => {
    expect(parseAnnotationValue("plain")).toEqual({ kind: "plain", text: "plain" });
  });

  it("treats malformed JSON as plain", () => {
    expect(parseAnnotationValue("{not json")).toEqual({ kind: "plain", text: "{not json" });
  });

  it("treats a JSON string scalar as plain", () => {
    expect(parseAnnotationValue('"x"')).toEqual({ kind: "plain", text: '"x"' });
  });

  it("treats a JSON number scalar as plain", () => {
    expect(parseAnnotationValue("5")).toEqual({ kind: "plain", text: "5" });
  });

  it("treats an empty string as plain", () => {
    expect(parseAnnotationValue("")).toEqual({ kind: "plain", text: "" });
  });
});
