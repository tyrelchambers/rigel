import { describe, it, expect } from "vitest";
import { parseArgs } from "./index";

describe("parseArgs", () => {
  it("parses record with a url", () => {
    expect(parseArgs(["record", "--url", "https://github.com/o/r/pull/1"])).toEqual({
      command: "record",
      prUrl: "https://github.com/o/r/pull/1",
      context: null,
      origin: "chat",
    });
  });

  it("parses the optional source and context", () => {
    expect(parseArgs(["record", "--url", "u", "--source", "web", "--context", "prod"])).toMatchObject({
      source: "web",
      context: "prod",
    });
  });

  it("accepts an explicit origin", () => {
    expect(parseArgs(["record", "--url", "u", "--origin", "agent"])).toMatchObject({ origin: "agent" });
  });

  it("rejects an unknown origin", () => {
    expect(() => parseArgs(["record", "--url", "u", "--origin", "nope"])).toThrow(/origin/i);
  });

  it("requires a url", () => {
    expect(() => parseArgs(["record"])).toThrow(/--url/);
  });

  it("rejects an unknown command", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(/usage/i);
  });

  it("rejects a flag with no value", () => {
    expect(() => parseArgs(["record", "--url"])).toThrow(/requires a value/);
  });
});
