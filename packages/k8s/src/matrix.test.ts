// packages/k8s/src/matrix.test.ts
import { test, expect } from "vitest";
import {
  MATRIX_SECRET_NAME,
  matrixSecretYAML,
  matrixConfigUpdates,
  matrixHomeserverUrl,
  matrixUserId,
  matrixRoomId,
  matrixAllowedSenders,
  matrixInbound,
  parseAllowedSenders,
  deriveMatrixConnected,
  matrixStatusColor,
  matrixStatusLabel,
} from "./matrix";

test("matrixSecretYAML builds the token Secret with name/key, escaping quotes", () => {
  const yaml = matrixSecretYAML('to"k', "agents");
  expect(yaml).toContain(`name: ${MATRIX_SECRET_NAME}`);
  expect(yaml).toContain("namespace: agents");
  expect(yaml).toContain('accessToken: "to\\"k"');
});

test("matrixSecretYAML defaults an empty namespace to default", () => {
  expect(matrixSecretYAML("t", "  ")).toContain("namespace: default");
});

test("matrixConfigUpdates includes only provided fields, inbound as a string", () => {
  expect(matrixConfigUpdates({ homeserverUrl: "https://hs", inbound: true })).toEqual({
    matrixHomeserverUrl: "https://hs",
    matrixInbound: "true",
  });
  expect(matrixConfigUpdates({ allowedSenders: "" })).toEqual({ matrixAllowedSenders: "" });
  expect(matrixConfigUpdates({})).toEqual({});
});

test("config readers pull the matrix keys", () => {
  const d = { matrixHomeserverUrl: "https://hs", matrixUserId: "@r:hs", matrixRoomId: "!x:hs", matrixAllowedSenders: "@a:hs", matrixInbound: "true" };
  expect(matrixHomeserverUrl(d)).toBe("https://hs");
  expect(matrixUserId(d)).toBe("@r:hs");
  expect(matrixRoomId(d)).toBe("!x:hs");
  expect(matrixAllowedSenders(d)).toBe("@a:hs");
  expect(matrixInbound(d)).toBe(true);
  expect(matrixInbound({})).toBe(false);
});

test("parseAllowedSenders splits on comma/newline and trims", () => {
  expect(parseAllowedSenders("@a:hs, @b:hs\n@c:hs ,")).toEqual(["@a:hs", "@b:hs", "@c:hs"]);
  expect(parseAllowedSenders("   ")).toEqual([]);
});

test("deriveMatrixConnected requires homeserver + user + room", () => {
  expect(deriveMatrixConnected({})).toBe(false);
  expect(deriveMatrixConnected({ matrixHomeserverUrl: "https://hs", matrixUserId: "@r:hs" })).toBe(false);
  expect(deriveMatrixConnected({ matrixHomeserverUrl: "https://hs", matrixUserId: "@r:hs", matrixRoomId: "!x:hs" })).toBe(true);
});

test("status color + label map the four states", () => {
  expect(matrixStatusColor("notConnected")).toBe("gray");
  expect(matrixStatusColor("connecting")).toBe("amber");
  expect(matrixStatusColor("connected")).toBe("green");
  expect(matrixStatusColor("error")).toBe("red");
  expect(matrixStatusLabel("connected")).toBe("Connected");
  expect(matrixStatusLabel("notConnected")).toMatch(/not connected/i);
});
