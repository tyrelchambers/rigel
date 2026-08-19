import { describe, expect, it } from "vitest";
import {
  CLAUDE_TOKEN_KEY,
  USER_CONFIG_KEYS,
  USER_CONFIG_SECRET,
  VOICE_CONFIG_KEY,
  emptyUserConfigData,
  isSecretAbsent,
  isUserConfigEmpty,
  parseUserConfigSecret,
  userConfigSecretJSON,
} from "./userConfig";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

describe("parseUserConfigSecret", () => {
  it("decodes the known keys", () => {
    const stdout = JSON.stringify({
      data: { [VOICE_CONFIG_KEY]: b64('{"url":"wss://x"}'), [CLAUDE_TOKEN_KEY]: b64("tok") },
    });
    const data = parseUserConfigSecret(stdout, unb64);
    expect(data[VOICE_CONFIG_KEY]).toBe('{"url":"wss://x"}');
    expect(data[CLAUDE_TOKEN_KEY]).toBe("tok");
  });

  it("drops keys it does not own", () => {
    const stdout = JSON.stringify({ data: { smuggled: b64("nope"), [CLAUDE_TOKEN_KEY]: b64("tok") } });
    expect(Object.keys(parseUserConfigSecret(stdout, unb64)).sort()).toEqual([...USER_CONFIG_KEYS].sort());
  });

  it("reads malformed or dataless payloads as empty rather than throwing", () => {
    expect(parseUserConfigSecret("not json", unb64)).toEqual(emptyUserConfigData());
    expect(parseUserConfigSecret("{}", unb64)).toEqual(emptyUserConfigData());
    expect(parseUserConfigSecret(JSON.stringify({ data: "nope" }), unb64)).toEqual(emptyUserConfigData());
  });
});

describe("userConfigSecretJSON", () => {
  it("writes every key, so an apply never has to delete one", () => {
    const manifest = JSON.parse(userConfigSecretJSON("default", emptyUserConfigData()));
    expect(manifest.kind).toBe("Secret");
    expect(manifest.metadata.name).toBe(USER_CONFIG_SECRET);
    expect(manifest.metadata.namespace).toBe("default");
    expect(manifest.metadata.labels["app.kubernetes.io/managed-by"]).toBe("rigel");
    expect(Object.keys(manifest.stringData).sort()).toEqual([...USER_CONFIG_KEYS].sort());
  });

  it("round-trips through parseUserConfigSecret", () => {
    const data = { ...emptyUserConfigData(), [CLAUDE_TOKEN_KEY]: "tok" };
    const { stringData } = JSON.parse(userConfigSecretJSON("default", data));
    const encoded: Record<string, string> = {};
    for (const [k, v] of Object.entries(stringData)) encoded[k] = b64(v as string);
    expect(parseUserConfigSecret(JSON.stringify({ data: encoded }), unb64)).toEqual(data);
  });
});

describe("isSecretAbsent", () => {
  it("is true only for an apiserver NotFound", () => {
    expect(isSecretAbsent({ code: 1, stderr: 'Error from server (NotFound): secrets "x" not found' })).toBe(true);
  });

  it("is false for anything that means the cluster was not reached", () => {
    expect(isSecretAbsent({ code: 1, stderr: "The connection to the server 127.0.0.1:6443 was refused" })).toBe(false);
    expect(isSecretAbsent({ code: 1, stderr: 'error: context "gone" does not exist' })).toBe(false);
    expect(isSecretAbsent({ code: 1, stderr: 'Error from server (Forbidden): secrets "x" is forbidden' })).toBe(false);
    expect(isSecretAbsent({ code: -1, stderr: "spawn kubectl ENOENT" })).toBe(false);
  });

  it("is false on success", () => {
    expect(isSecretAbsent({ code: 0, stderr: "" })).toBe(false);
  });
});

describe("isUserConfigEmpty", () => {
  it("is true for a fresh config and false once anything is stored", () => {
    expect(isUserConfigEmpty(emptyUserConfigData())).toBe(true);
    expect(isUserConfigEmpty({ ...emptyUserConfigData(), [CLAUDE_TOKEN_KEY]: "tok" })).toBe(false);
  });
});
