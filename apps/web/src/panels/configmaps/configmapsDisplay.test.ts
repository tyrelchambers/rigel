import { describe, expect, test } from "vitest";
import type { ConfigMap } from "./types";
import {
  relativeAge,
  humanAge,
  keyCount,
  binaryKeyCount,
  keysSorted,
  isBinaryKey,
  plaintextBytes,
  binaryBytes,
  matchesSearch,
  sortConfigMaps,
  humanBytes,
  valueKind,
  kindLabel,
  valueLines,
  namespaceDotColor,
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

describe("humanAge (re-exported shared formatter)", () => {
  const now = Date.parse("2026-06-09T12:00:00Z");
  test("long form with pluralization", () => {
    expect(humanAge("2025-12-26T12:00:00Z", now)).toBe("165 days");
    expect(humanAge("2026-06-08T12:00:00Z", now)).toBe("1 day");
    expect(humanAge("2026-06-09T11:00:00Z", now)).toBe("1 hour");
    expect(humanAge("2026-06-09T11:57:00Z", now)).toBe("3 minutes");
    expect(humanAge("2026-06-09T11:59:59Z", now)).toBe("just now");
  });
  test("missing timestamp → —", () => {
    expect(humanAge(undefined, now)).toBe("—");
  });
});

describe("humanBytes", () => {
  test("bytes under 1 KB", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(566)).toBe("566 B");
    expect(humanBytes(1023)).toBe("1023 B");
  });
  test("KB / MB with trimmed decimals", () => {
    expect(humanBytes(1024)).toBe("1 KB");
    expect(humanBytes(1536)).toBe("1.5 KB");
    expect(humanBytes(10 * 1024)).toBe("10 KB");
    expect(humanBytes(1024 * 1024)).toBe("1 MB");
    expect(humanBytes(1536 * 1024)).toBe("1.5 MB");
  });
});

describe("valueKind", () => {
  test("certificate via PEM header", () => {
    expect(valueKind("ca.crt", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----")).toBe(
      "certificate",
    );
  });
  test("json via leading brace/bracket that parses", () => {
    expect(valueKind("config.json", '{"a":1}')).toBe("json");
    expect(valueKind("list", "[1, 2, 3]")).toBe("json");
    expect(valueKind("x", "  \n{\"a\":1}")).toBe("json");
  });
  test("brace that does not parse falls back to text", () => {
    expect(valueKind("broken", "{not json")).toBe("text");
  });
  test("yaml by key extension", () => {
    expect(valueKind("database.yaml", "a: 1\nb: 2")).toBe("yaml");
    expect(valueKind("values.YML", "a: 1")).toBe("yaml");
  });
  test("plain text default", () => {
    expect(valueKind("notes", "hello world")).toBe("text");
    expect(valueKind("EMPTY", "")).toBe("text");
  });
});

describe("kindLabel", () => {
  test("uppercase labels", () => {
    expect(kindLabel("certificate")).toBe("CERTIFICATE");
    expect(kindLabel("json")).toBe("JSON");
    expect(kindLabel("yaml")).toBe("YAML");
    expect(kindLabel("text")).toBe("TEXT");
  });
});

describe("valueLines", () => {
  test("splits on newline", () => {
    expect(valueLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });
  test("drops a single trailing newline (N lines, not N+1)", () => {
    expect(valueLines("a\nb\n")).toEqual(["a", "b"]);
  });
  test("empty string is one empty line", () => {
    expect(valueLines("")).toEqual([""]);
  });
  test("single line", () => {
    expect(valueLines("solo")).toEqual(["solo"]);
  });
});

describe("namespaceDotColor", () => {
  test("deterministic for the same namespace", () => {
    expect(namespaceDotColor("default")).toBe(namespaceDotColor("default"));
    expect(namespaceDotColor("cert-manager")).toBe(namespaceDotColor("cert-manager"));
  });
  test("returns a palette hex color", () => {
    const hex = /^#[0-9A-F]{6}$/i;
    for (const ns of ["default", "cert-manager", "cnpg-system", "", "kube-system"]) {
      expect(namespaceDotColor(ns)).toMatch(hex);
    }
  });
});
