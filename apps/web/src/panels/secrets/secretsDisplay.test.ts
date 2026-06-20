import { describe, expect, test } from "vitest";
import type { Secret } from "@rigel/k8s";
import {
  relativeAge,
  keyCount,
  keysSorted,
  secretTypeDisplayName,
  decoded,
  rawBytes,
  matchesSearch,
  sortSecrets,
} from "./secretsDisplay";

/** base64 of a string's UTF-8 bytes, mirroring how kubectl encodes values. */
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function secret(overrides: Partial<Secret> = {}): Secret {
  return {
    metadata: { name: "sec", namespace: "default", uid: "u1", ...overrides.metadata },
    type: overrides.type,
    data: overrides.data,
  };
}

describe("keyCount", () => {
  test("counts data keys", () => {
    expect(keyCount(secret({ data: { a: b64("1"), b: b64("2") } }))).toBe(2);
  });
  test("zero when data absent", () => {
    expect(keyCount(secret())).toBe(0);
  });
});

describe("keysSorted", () => {
  test("sorts alphabetically", () => {
    expect(keysSorted(secret({ data: { zebra: b64("1"), apple: b64("2"), mango: b64("3") } }))).toEqual([
      "apple",
      "mango",
      "zebra",
    ]);
  });
  test("empty when no keys", () => {
    expect(keysSorted(secret())).toEqual([]);
  });
});

describe("secretTypeDisplayName", () => {
  test("maps every known type", () => {
    expect(secretTypeDisplayName("Opaque")).toBe("Opaque");
    expect(secretTypeDisplayName("kubernetes.io/dockerconfigjson")).toBe("Docker registry");
    expect(secretTypeDisplayName("kubernetes.io/tls")).toBe("TLS");
    expect(secretTypeDisplayName("kubernetes.io/basic-auth")).toBe("Basic auth");
    expect(secretTypeDisplayName("kubernetes.io/ssh-auth")).toBe("SSH auth");
    expect(secretTypeDisplayName("kubernetes.io/service-account-token")).toBe("Service-account token");
  });
  test("undefined / empty default to Opaque", () => {
    expect(secretTypeDisplayName(undefined)).toBe("Opaque");
    expect(secretTypeDisplayName("")).toBe("Opaque");
  });
  test("unknown type falls back to Other", () => {
    expect(secretTypeDisplayName("bootstrap.kubernetes.io/token")).toBe("Other");
    expect(secretTypeDisplayName("custom.example.com/whatever")).toBe("Other");
  });
});

describe("rawBytes", () => {
  test("decodes base64 byte count", () => {
    expect(rawBytes(secret({ data: { k: b64("hello") } }), "k")).toBe(5); // "hello" → 5 bytes
    expect(rawBytes(secret({ data: { k: b64("abc") } }), "k")).toBe(3);
  });
  test("UTF-8 multibyte counted as bytes", () => {
    // "é" is 2 bytes, "😀" is 4 bytes in UTF-8.
    expect(rawBytes(secret({ data: { k: b64("é") } }), "k")).toBe(2);
    expect(rawBytes(secret({ data: { k: b64("😀") } }), "k")).toBe(4);
  });
  test("missing key → 0", () => {
    expect(rawBytes(secret({ data: { k: b64("x") } }), "nope")).toBe(0);
    expect(rawBytes(secret(), "k")).toBe(0);
  });
  test("binary value byte count", () => {
    // single 0xFF byte → base64 "/w==" → 1 byte.
    expect(rawBytes(secret({ data: { k: "/w==" } }), "k")).toBe(1);
  });
  test("malformed base64 → 0", () => {
    expect(rawBytes(secret({ data: { k: "abc" } }), "k")).toBe(0); // length not multiple of 4
  });
});

describe("decoded", () => {
  test("returns UTF-8 text for valid keys", () => {
    expect(decoded(secret({ data: { k: b64("hello world") } }), "k")).toBe("hello world");
  });
  test("preserves multibyte UTF-8", () => {
    expect(decoded(secret({ data: { k: b64("café 😀") } }), "k")).toBe("café 😀");
  });
  test("returns null for non-UTF-8 binary", () => {
    // 0xFF is not a valid standalone UTF-8 byte → decode fails → null.
    expect(decoded(secret({ data: { k: "/w==" } }), "k")).toBeNull();
  });
  test("returns null for missing key", () => {
    expect(decoded(secret({ data: { k: b64("x") } }), "missing")).toBeNull();
    expect(decoded(secret(), "k")).toBeNull();
  });
  test("returns null for malformed base64", () => {
    expect(decoded(secret({ data: { k: "abc" } }), "k")).toBeNull();
  });
});

describe("matchesSearch", () => {
  const s = secret({
    metadata: { name: "registry-pull", namespace: "production", uid: "u1" },
    type: "kubernetes.io/dockerconfigjson",
    data: { ".dockerconfigjson": b64('{"auths":{"docker.io":{"password":"hunter2"}}}') },
  });

  test("blank query matches everything", () => {
    expect(matchesSearch(s, "")).toBe(true);
    expect(matchesSearch(s, "   ")).toBe(true);
  });
  test("matches name case-insensitively", () => {
    expect(matchesSearch(s, "REGISTRY")).toBe(true);
  });
  test("matches namespace", () => {
    expect(matchesSearch(s, "prod")).toBe(true);
  });
  test("matches raw type", () => {
    expect(matchesSearch(s, "dockerconfigjson")).toBe(true);
  });
  test("matches display type name", () => {
    expect(matchesSearch(s, "docker registry")).toBe(true);
  });
  test("matches key names", () => {
    expect(matchesSearch(s, ".dockerconfig")).toBe(true);
  });
  test("no match returns false", () => {
    expect(matchesSearch(s, "nonexistent")).toBe(false);
  });
  test("does NOT match decoded values (sensitive)", () => {
    // "hunter2" is inside the decoded value — must never be searchable.
    expect(matchesSearch(s, "hunter2")).toBe(false);
  });
});

describe("sortSecrets", () => {
  test("sorts by namespace then name", () => {
    const list = [
      secret({ metadata: { name: "b", namespace: "ns2", uid: "1" } }),
      secret({ metadata: { name: "a", namespace: "ns2", uid: "2" } }),
      secret({ metadata: { name: "z", namespace: "ns1", uid: "3" } }),
    ];
    expect(sortSecrets(list).map((s) => `${s.metadata.namespace}/${s.metadata.name}`)).toEqual([
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
