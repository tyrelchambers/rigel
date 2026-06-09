import { describe, expect, test } from "vitest";
import type { ConfigMap } from "./types";
import {
  relativeAge,
  keyCount,
  binaryKeyCount,
  keysSorted,
  isBinaryKey,
  plaintextBytes,
  binaryBytes,
  matchesSearch,
  sortConfigMaps,
} from "./configmapsDisplay";

function cm(overrides: Partial<ConfigMap> = {}): ConfigMap {
  return {
    metadata: { name: "cfg", namespace: "default", uid: "u1", ...overrides.metadata },
    data: overrides.data,
    binaryData: overrides.binaryData,
  };
}

describe("keyCount", () => {
  test("sums data + binaryData keys", () => {
    expect(keyCount(cm({ data: { a: "1", b: "2" }, binaryData: { c: "AA==" } }))).toBe(3);
  });
  test("zero when both absent", () => {
    expect(keyCount(cm())).toBe(0);
  });
  test("data only", () => {
    expect(keyCount(cm({ data: { a: "1" } }))).toBe(1);
  });
});

describe("binaryKeyCount", () => {
  test("counts only binaryData keys", () => {
    expect(binaryKeyCount(cm({ data: { a: "1" }, binaryData: { c: "AA==", d: "AA==" } }))).toBe(2);
  });
  test("zero when binaryData absent", () => {
    expect(binaryKeyCount(cm({ data: { a: "1" } }))).toBe(0);
  });
});

describe("keysSorted", () => {
  test("unions and sorts alphabetically", () => {
    expect(keysSorted(cm({ data: { zebra: "1", apple: "2" }, binaryData: { mango: "AA==" } }))).toEqual([
      "apple",
      "mango",
      "zebra",
    ]);
  });
  test("empty when no keys", () => {
    expect(keysSorted(cm())).toEqual([]);
  });
});

describe("isBinaryKey", () => {
  test("true for binaryData keys, false for plaintext", () => {
    const c = cm({ data: { plain: "x" }, binaryData: { bin: "AA==" } });
    expect(isBinaryKey(c, "bin")).toBe(true);
    expect(isBinaryKey(c, "plain")).toBe(false);
    expect(isBinaryKey(c, "missing")).toBe(false);
  });
});

describe("plaintextBytes", () => {
  test("ASCII byte count", () => {
    expect(plaintextBytes("hello")).toBe(5);
  });
  test("empty string", () => {
    expect(plaintextBytes("")).toBe(0);
  });
  test("UTF-8 multibyte chars", () => {
    // "é" is 2 bytes, "😀" is 4 bytes in UTF-8.
    expect(plaintextBytes("é")).toBe(2);
    expect(plaintextBytes("😀")).toBe(4);
  });
});

describe("binaryBytes", () => {
  test("decodes base64 byte count", () => {
    // "hello" base64 = "aGVsbG8=" → 5 bytes.
    expect(binaryBytes("aGVsbG8=")).toBe(5);
    // 3 bytes, no padding.
    expect(binaryBytes("YWJj")).toBe(3); // "abc"
    // 1 byte → "AA==" → 1.
    expect(binaryBytes("AA==")).toBe(1);
    // 2 bytes → "AAA=" → 2.
    expect(binaryBytes("AAA=")).toBe(2);
  });
  test("empty string → 0", () => {
    expect(binaryBytes("")).toBe(0);
  });
  test("ignores embedded whitespace/newlines", () => {
    expect(binaryBytes("aGVs\nbG8=")).toBe(5);
  });
  test("malformed base64 → 0", () => {
    expect(binaryBytes("abc")).toBe(0); // length not multiple of 4
  });
});

describe("matchesSearch", () => {
  const c = cm({
    metadata: { name: "app-config", namespace: "production", uid: "u1" },
    data: { "database.yaml": "x", "API_KEY": "y" },
    binaryData: { "cert.pem": "AA==" },
  });

  test("blank query matches everything", () => {
    expect(matchesSearch(c, "")).toBe(true);
    expect(matchesSearch(c, "   ")).toBe(true);
  });
  test("matches name case-insensitively", () => {
    expect(matchesSearch(c, "APP-CONFIG")).toBe(true);
  });
  test("matches namespace", () => {
    expect(matchesSearch(c, "prod")).toBe(true);
  });
  test("matches plaintext key names", () => {
    expect(matchesSearch(c, "database")).toBe(true);
  });
  test("matches binary key names", () => {
    expect(matchesSearch(c, "cert")).toBe(true);
  });
  test("no match returns false", () => {
    expect(matchesSearch(c, "nonexistent")).toBe(false);
  });
  test("does not match values, only keys/name/namespace", () => {
    // "x" is a value of database.yaml but should not match any key/name/ns.
    expect(matchesSearch(c, "x")).toBe(false);
  });
});

describe("sortConfigMaps", () => {
  test("sorts by namespace then name", () => {
    const list = [
      cm({ metadata: { name: "b", namespace: "ns2", uid: "1" } }),
      cm({ metadata: { name: "a", namespace: "ns2", uid: "2" } }),
      cm({ metadata: { name: "z", namespace: "ns1", uid: "3" } }),
    ];
    expect(sortConfigMaps(list).map((c) => `${c.metadata.namespace}/${c.metadata.name}`)).toEqual([
      "ns1/z",
      "ns2/a",
      "ns2/b",
    ]);
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-06-09T12:00:00Z");
  test("seconds / minutes / hours / days", () => {
    expect(relativeAge("2026-06-09T11:59:30Z", now)).toBe("30s");
    expect(relativeAge("2026-06-09T11:55:00Z", now)).toBe("5m");
    expect(relativeAge("2026-06-09T10:00:00Z", now)).toBe("2h");
    expect(relativeAge("2026-06-07T12:00:00Z", now)).toBe("2d");
  });
  test("missing timestamp → —", () => {
    expect(relativeAge(undefined, now)).toBe("—");
  });
});
