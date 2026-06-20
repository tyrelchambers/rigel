import { describe, expect, it } from "vitest";
import { buildBrowseQuery } from "./helmApi";

describe("buildBrowseQuery", () => {
  it("sets offset/limit and omits empty query and false flags", () => {
    const qs = new URLSearchParams(buildBrowseQuery({ query: "", official: false }, 0, 24));
    expect(qs.get("offset")).toBe("0");
    expect(qs.get("limit")).toBe("24");
    expect(qs.has("q")).toBe(false);
    expect(qs.has("official")).toBe(false);
  });

  it("trims the query and includes sort + flags", () => {
    const qs = new URLSearchParams(buildBrowseQuery({ query: "  loki ", sort: "stars", official: true, verified: true }, 24, 24));
    expect(qs.get("q")).toBe("loki");
    expect(qs.get("sort")).toBe("stars");
    expect(qs.get("official")).toBe("true");
    expect(qs.get("verified")).toBe("true");
    expect(qs.get("offset")).toBe("24");
  });
});
