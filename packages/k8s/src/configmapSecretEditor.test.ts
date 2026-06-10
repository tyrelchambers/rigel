import { test, expect, describe } from "bun:test";
import type { ConfigMap, Secret } from "./index";
import {
  CREATABLE_SECRET_TYPES,
  canonicalKeysFor,
  secretTypeId,
  encodeSecretValue,
  decodeSecretValue,
  decodedByteLength,
  validateConfigMapName,
  validateSecretName,
  canSubmitConfigMap,
  canSubmitSecret,
  emptyDockerCreds,
  encodeDockerConfigJson,
  parseDockerCredsForm,
  buildConfigMapYAML,
  buildSecretYAML,
  blankRow,
  seedConfigMapRows,
  seedSecretRows,
  rowsToConfigMapData,
  base64Decode,
  type KVRow,
} from "./index";

function row(key: string, value: string, binary?: { bytes: number }): KVRow {
  return { id: `${key}-${value}`, key, value, ...(binary ? { binary } : {}) };
}

// --- Secret type metadata ---------------------------------------------------

describe("secret types", () => {
  test("Opaque is first and has no canonical keys", () => {
    expect(CREATABLE_SECRET_TYPES[0]!.id).toBe("Opaque");
    expect(canonicalKeysFor("Opaque")).toEqual([]);
  });
  test("canonical keys per type match k8s built-ins", () => {
    expect(canonicalKeysFor("kubernetes.io/tls")).toEqual(["tls.crt", "tls.key"]);
    expect(canonicalKeysFor("kubernetes.io/basic-auth")).toEqual(["username", "password"]);
    expect(canonicalKeysFor("kubernetes.io/ssh-auth")).toEqual(["ssh-privatekey"]);
    expect(canonicalKeysFor("kubernetes.io/dockerconfigjson")).toEqual([".dockerconfigjson"]);
  });
  test("secretTypeId normalizes absent/empty/unknown to Opaque", () => {
    expect(secretTypeId(undefined)).toBe("Opaque");
    expect(secretTypeId("")).toBe("Opaque");
    expect(secretTypeId("kubernetes.io/service-account-token")).toBe("Opaque");
    expect(secretTypeId("kubernetes.io/tls")).toBe("kubernetes.io/tls");
  });
});

// --- base64 round-trip ------------------------------------------------------

describe("encode/decodeSecretValue", () => {
  test("plaintext round-trips through base64", () => {
    for (const s of ["", "hunter2", "naïve:tökén", "multi\nline\nvalue"]) {
      expect(decodeSecretValue(encodeSecretValue(s))).toBe(s);
    }
  });
  test("decode returns null for binary (invalid UTF-8)", () => {
    const b64 = btoa("\xff\xfe\x00\x01"); // not valid UTF-8
    expect(decodeSecretValue(b64)).toBeNull();
  });
  test("decodedByteLength counts raw bytes", () => {
    expect(decodedByteLength(encodeSecretValue("hello"))).toBe(5);
    expect(decodedByteLength("")).toBe(0);
  });
});

// --- validation -------------------------------------------------------------

describe("name validation", () => {
  test("non-empty after trim", () => {
    expect(validateConfigMapName("ok")).toBe(true);
    expect(validateConfigMapName("  ")).toBe(false);
    expect(validateSecretName("")).toBe(false);
    expect(validateSecretName("my-secret")).toBe(true);
  });
});

describe("canSubmitConfigMap", () => {
  test("requires non-empty name + namespace, unique keys", () => {
    expect(canSubmitConfigMap("cm", "default", [row("a", "1")])).toBe(true);
    expect(canSubmitConfigMap("", "default", [row("a", "1")])).toBe(false);
    expect(canSubmitConfigMap("cm", "", [row("a", "1")])).toBe(false);
  });
  test("rejects duplicate keys", () => {
    expect(canSubmitConfigMap("cm", "default", [row("a", "1"), row("a", "2")])).toBe(false);
  });
  test("allows empty values and empty-key rows", () => {
    expect(canSubmitConfigMap("cm", "default", [row("a", ""), row("", "ignored")])).toBe(true);
  });
});

describe("canSubmitSecret", () => {
  const docker = emptyDockerCreds();
  test("Opaque needs >=1 non-empty unique key", () => {
    expect(canSubmitSecret("s", "default", "Opaque", [row("a", "v")], docker)).toBe(true);
    expect(canSubmitSecret("s", "default", "Opaque", [row("", "")], docker)).toBe(false);
    expect(
      canSubmitSecret("s", "default", "Opaque", [row("a", "1"), row("a", "2")], docker),
    ).toBe(false);
  });
  test("TLS needs both canonical keys filled", () => {
    const filled = [row("tls.crt", "CERT"), row("tls.key", "KEY")];
    const missing = [row("tls.crt", "CERT"), row("tls.key", "")];
    expect(canSubmitSecret("s", "default", "kubernetes.io/tls", filled, docker)).toBe(true);
    expect(canSubmitSecret("s", "default", "kubernetes.io/tls", missing, docker)).toBe(false);
  });
  test("binary canonical row counts as filled (carried unchanged)", () => {
    const rows = [row("tls.crt", "", { bytes: 1024 }), row("tls.key", "KEY")];
    expect(canSubmitSecret("s", "default", "kubernetes.io/tls", rows, docker)).toBe(true);
  });
  test("Docker registry needs server/user/pass", () => {
    const d = { server: "ghcr.io", username: "u", password: "p", email: "" };
    expect(canSubmitSecret("s", "default", "kubernetes.io/dockerconfigjson", [], d)).toBe(true);
    expect(
      canSubmitSecret("s", "default", "kubernetes.io/dockerconfigjson", [], {
        ...d,
        password: "",
      }),
    ).toBe(false);
  });
  test("name + namespace required regardless of type", () => {
    expect(canSubmitSecret("", "default", "Opaque", [row("a", "v")], docker)).toBe(false);
    expect(canSubmitSecret("s", "", "Opaque", [row("a", "v")], docker)).toBe(false);
  });
});

// --- ConfigMap YAML ---------------------------------------------------------

describe("buildConfigMapYAML", () => {
  test("single key single-line value", () => {
    const yaml = buildConfigMapYAML("my-config", "default", { foo: "bar" });
    expect(yaml).toBe(
      [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: 'my-config'",
        "  namespace: 'default'",
        "data:",
        "  'foo': 'bar'",
        "",
      ].join("\n"),
    );
  });
  test("multi-line value emits a literal block scalar", () => {
    const yaml = buildConfigMapYAML("c", "default", {
      "app.conf": "server:\n  port: 8080\n  debug: false",
    });
    expect(yaml).toContain("  'app.conf': |-");
    expect(yaml).toContain("    server:");
    expect(yaml).toContain("      port: 8080");
    expect(yaml).toContain("      debug: false");
  });
  test("trailing newline → clip (|), no trailing → strip (|-)", () => {
    expect(buildConfigMapYAML("c", "d", { k: "a\nb\n" })).toContain("  'k': |\n");
    expect(buildConfigMapYAML("c", "d", { k: "a\nb" })).toContain("  'k': |-\n");
  });
  test("binaryData carried through unchanged, sorted, after data", () => {
    const yaml = buildConfigMapYAML(
      "c",
      "default",
      { z: "1", a: "2" },
      { "cert.pem": "QklOQVJZ" },
    );
    const lines = yaml.split("\n");
    // data sorted: a before z
    expect(lines.indexOf("  'a': '2'")).toBeLessThan(lines.indexOf("  'z': '1'"));
    expect(yaml).toContain("binaryData:");
    expect(yaml).toContain("  'cert.pem': 'QklOQVJZ'");
    expect(yaml.indexOf("data:")).toBeLessThan(yaml.indexOf("binaryData:"));
  });
  test("empty data/binaryData maps are omitted", () => {
    const yaml = buildConfigMapYAML("c", "default", {});
    expect(yaml).not.toContain("\ndata:");
    expect(yaml).not.toContain("binaryData:");
  });
  test("single-quotes are doubled", () => {
    expect(buildConfigMapYAML("c", "d", { k: "a'b" })).toContain("  'k': 'a''b'");
  });
});

// --- Secret YAML ------------------------------------------------------------

describe("buildSecretYAML", () => {
  test("plaintext values base64-encoded into data, type included", () => {
    const yaml = buildSecretYAML("s", "default", "Opaque", { user: "admin", pass: "p@ss" });
    expect(yaml).toContain("type: 'Opaque'");
    expect(yaml).toContain("data:");
    // 'admin' → YWRtaW4=
    expect(yaml).toContain(`  'user': '${encodeSecretValue("admin")}'`);
    expect(yaml).toContain(`  'pass': '${encodeSecretValue("p@ss")}'`);
    // never stringData
    expect(yaml).not.toContain("stringData");
  });
  test("keys sorted", () => {
    const yaml = buildSecretYAML("s", "d", "Opaque", { z: "1", a: "2" });
    expect(yaml.indexOf("'a'")).toBeLessThan(yaml.indexOf("'z'"));
  });
  test("preEncodedData passed through verbatim (binary preserved)", () => {
    const yaml = buildSecretYAML(
      "s",
      "d",
      "kubernetes.io/tls",
      { "tls.key": "KEYTEXT" },
      { "tls.crt": "QUxSRUFEWUI2NA==" },
    );
    expect(yaml).toContain("  'tls.crt': 'QUxSRUFEWUI2NA=='");
    expect(yaml).toContain(`  'tls.key': '${encodeSecretValue("KEYTEXT")}'`);
  });
  test("TLS type string carried", () => {
    expect(buildSecretYAML("s", "d", "kubernetes.io/tls", {})).toContain(
      "type: 'kubernetes.io/tls'",
    );
  });
});

// --- Docker registry assembly ----------------------------------------------

describe("encodeDockerConfigJson / parse round-trip", () => {
  test("assembles auths with base64 auth field and round-trips", () => {
    const form = { server: "ghcr.io", username: "octocat", password: "tok", email: "o@x.com" };
    const b64 = encodeDockerConfigJson(form);
    const json = JSON.parse(base64Decode(b64)!);
    const entry = json.auths["ghcr.io"];
    expect(entry.username).toBe("octocat");
    expect(entry.password).toBe("tok");
    expect(base64Decode(entry.auth)).toBe("octocat:tok");
    expect(entry.email).toBe("o@x.com");

    const parsed = parseDockerCredsForm(base64Decode(b64)!);
    expect(parsed).toEqual({
      server: "ghcr.io",
      username: "octocat",
      password: "tok",
      email: "o@x.com",
    });
  });
  test("omits email when blank", () => {
    const b64 = encodeDockerConfigJson({ server: "r", username: "u", password: "p", email: "" });
    const json = JSON.parse(base64Decode(b64)!);
    expect(json.auths["r"].email).toBeUndefined();
  });
  test("parse returns null on malformed", () => {
    expect(parseDockerCredsForm("not json")).toBeNull();
    expect(parseDockerCredsForm("{}")).toBeNull();
  });
});

// --- seeding rows -----------------------------------------------------------

describe("seedConfigMapRows", () => {
  test("seeds sorted plaintext data, ignores binaryData", () => {
    const cm: ConfigMap = {
      metadata: { name: "c", namespace: "default", uid: "1" },
      data: { z: "1", a: "2" },
      binaryData: { "cert.pem": "QklO" },
    };
    const rows = seedConfigMapRows(cm);
    expect(rows.map((r) => r.key)).toEqual(["a", "z"]);
    expect(rows.every((r) => !r.binary)).toBe(true);
  });
  test("blank row when no data", () => {
    const rows = seedConfigMapRows({ metadata: { name: "c", uid: "1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("");
  });
});

describe("seedSecretRows", () => {
  test("decodes UTF-8 values, marks binary read-only", () => {
    const secret: Secret = {
      metadata: { name: "s", namespace: "default", uid: "1" },
      type: "Opaque",
      data: {
        text: encodeSecretValue("hello"),
        blob: btoa("\xff\xfe\x00\x01"),
      },
    };
    const rows = seedSecretRows(secret);
    const text = rows.find((r) => r.key === "text")!;
    const blob = rows.find((r) => r.key === "blob")!;
    expect(text.value).toBe("hello");
    expect(text.binary).toBeUndefined();
    expect(blob.binary).toBeDefined();
    expect(blob.binary!.bytes).toBe(4);
    expect(blob.value).toBe("");
  });
});

describe("rowsToConfigMapData", () => {
  test("trims keys, drops empty-key rows, last write wins", () => {
    expect(
      rowsToConfigMapData([row("  a  ", "1"), row("", "skip"), row("a", "2")]),
    ).toEqual({ a: "2" });
  });
});

describe("blankRow", () => {
  test("unique ids", () => {
    expect(blankRow().id).not.toBe(blankRow().id);
  });
});
