import { describe, expect, test } from "vitest";
import { REDACTED, redactSecretValues, refusesForSecretValues } from "./secretRedaction";

/** A real value, and the base64 kubectl would print for it. */
const PLAINTEXT = "hunter2-super-secret";
const ENCODED = Buffer.from(PLAINTEXT).toString("base64");

const SECRET_YAML = `apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: default
type: Opaque
data:
  password: ${ENCODED}
  url: ${Buffer.from("postgres://u:p@host/db").toString("base64")}
`;

/** Neither the encoded nor the decoded value may survive, on any path. */
function assertNoValue(out: string) {
  expect(out).not.toContain(ENCODED);
  expect(out).not.toContain(PLAINTEXT);
}

describe("redactSecretValues", () => {
  test("replaces every data value while keeping everything that is not a value", () => {
    const out = redactSecretValues(SECRET_YAML);
    assertNoValue(out);
    expect(out).toContain("db-credentials");
    expect(out).toContain("Opaque");
    expect(out).toContain("password");
    expect(out).toContain("url");
    expect(out).toContain(REDACTED);
  });

  test("redacts stringData as well as data", () => {
    const out = redactSecretValues(`apiVersion: v1
kind: Secret
metadata:
  name: s
stringData:
  password: ${PLAINTEXT}
`);
    assertNoValue(out);
  });

  test("redacts a Secret embedded in a List, and leaves its siblings alone", () => {
    const list = JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cm" }, data: { keep: "visible" } },
        { apiVersion: "v1", kind: "Secret", metadata: { name: "s" }, data: { password: ENCODED } },
      ],
    });
    const out = redactSecretValues(list);
    assertNoValue(out);
    expect(out).toContain("visible");
  });

  test("redacts every document of a multi-document read", () => {
    const out = redactSecretValues(`${SECRET_YAML}---\n${SECRET_YAML}`);
    assertNoValue(out);
    expect(out.match(new RegExp(REDACTED.replace(/[()]/g, "\\$&"), "g"))?.length).toBe(4);
  });

  // A Helm release is a Secret whose data.release is the whole chart plus its
  // values, which routinely carry credentials. It is kind: Secret, so it is
  // covered by the same walk with no special case.
  test("redacts a Helm release secret", () => {
    const out = redactSecretValues(`apiVersion: v1
kind: Secret
metadata:
  name: sh.helm.release.v1.memos.v1
type: helm.sh/release.v1
data:
  release: ${ENCODED}
`);
    assertNoValue(out);
  });

  test("the placeholder is not valid base64, so a redacted manifest can never be applied", () => {
    // kubectl rejects it rather than writing "(redacted by Rigel)" over a live
    // Secret's real value.
    expect(() => {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(REDACTED)) throw new Error("not base64");
    }).toThrow();
  });

  test("a read that is not a Secret comes back byte for byte", () => {
    const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
`;
    expect(redactSecretValues(deployment)).toBe(deployment);
  });

  test("output that parses as neither JSON nor YAML passes through", () => {
    const table = "NAME   TYPE     DATA   AGE\ndb     Opaque   2      216d\n";
    expect(redactSecretValues(table)).toBe(table);
  });

  test("a Secret with no data at all is left alone", () => {
    const empty = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ntype: Opaque\n";
    expect(redactSecretValues(empty)).toBe(empty);
  });
});

describe("refusesForSecretValues", () => {
  // These print the bare value with no structure left to redact, so they are
  // refused at argv time rather than filtered afterwards.
  test("refuses value extraction aimed at a secret, joined or split argv", () => {
    const extracting = [
      ["-o=jsonpath={.data.password}"],
      ["-o", "jsonpath={.data.password}"],
      ["-o", "go-template={{.data}}"],
      ["-o", "custom-columns=V:.data.password"],
    ];
    for (const format of extracting) {
      expect(refusesForSecretValues(["get", "secret", "db", ...format]), format.join(" ")).toBe(true);
    }
    expect(refusesForSecretValues(["get", "secret/db", "-o", "jsonpath={.data}"])).toBe(true);
  });

  test("allows the same extraction on anything that is not a secret", () => {
    expect(refusesForSecretValues(["get", "deployment", "web", "-o", "jsonpath={.spec.replicas}"])).toBe(false);
  });

  test("allows a secret read whose output can be redacted", () => {
    for (const format of ["yaml", "json", "wide"]) {
      expect(refusesForSecretValues(["get", "secret", "db", "-o", format])).toBe(false);
    }
    expect(refusesForSecretValues(["describe", "secret", "db"])).toBe(false);
  });
});
