import { test, expect, describe } from "vitest";
import type { Secret } from "./index";
import {
  DOCKER_HUB_KEY,
  DOCKERCONFIGJSON_TYPE,
  DOCKERCONFIGJSON_KEY,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  base64Encode,
  base64Decode,
  normalizeRegistryKey,
  buildDockerConfigJson,
  buildAuths,
  dockerconfigjsonToSecret,
  parseDockerConfigJson,
  extractRegistryFromSecret,
  displayRegistry,
  isValidDNS1123Subdomain,
} from "./dockerconfigjson";

// --- base64 round-trip (UTF-8 safe) ----------------------------------------

describe("base64", () => {
  test("round-trips UTF-8 strings including non-ASCII", () => {
    for (const s of ["", "hello", "user:p@ss/word", "naïve:tökén"]) {
      expect(base64Decode(base64Encode(s))).toBe(s);
    }
  });

  test("decode tolerates embedded whitespace", () => {
    const enc = base64Encode("alice:secret");
    expect(base64Decode(`${enc.slice(0, 4)}\n${enc.slice(4)}`)).toBe("alice:secret");
  });
});

// --- Docker Hub hostname normalization -------------------------------------

describe("normalizeRegistryKey", () => {
  test("collapses every Docker Hub alias to the canonical key", () => {
    for (const alias of [
      "docker.io",
      "index.docker.io",
      "registry-1.docker.io",
      "https://index.docker.io/v1/",
      "https://docker.io",
      "DOCKER.IO",
    ]) {
      expect(normalizeRegistryKey(alias)).toBe(DOCKER_HUB_KEY);
    }
  });

  test("passes other registries through (trimmed, scheme preserved)", () => {
    expect(normalizeRegistryKey("ghcr.io")).toBe("ghcr.io");
    expect(normalizeRegistryKey("quay.io")).toBe("quay.io");
    expect(normalizeRegistryKey("  registry.example.com  ")).toBe("registry.example.com");
  });
});

// --- buildDockerConfigJson / buildAuths -------------------------------------

describe("buildDockerConfigJson", () => {
  test("encodes the auth field as base64(username:password)", () => {
    const encoded = buildDockerConfigJson("ghcr.io", "alice", "tok123");
    const decoded = base64Decode(encoded)!;
    const cfg = parseDockerConfigJson(decoded);
    const entry = cfg.auths["ghcr.io"]!;
    expect(entry.username).toBe("alice");
    expect(entry.password).toBe("tok123");
    expect(base64Decode(entry.auth)).toBe("alice:tok123");
  });

  test("docker.io credential lands under the canonical Hub key", () => {
    const cfg = parseDockerConfigJson(base64Decode(buildDockerConfigJson("docker.io", "bob", "pw"))!);
    expect(Object.keys(cfg.auths)).toEqual([DOCKER_HUB_KEY]);
  });

  test("omits email unless provided", () => {
    const without = parseDockerConfigJson(base64Decode(buildDockerConfigJson("ghcr.io", "a", "b"))!);
    expect(without.auths["ghcr.io"]!.email).toBeUndefined();
    const withEmail = parseDockerConfigJson(
      base64Decode(buildDockerConfigJson("ghcr.io", "a", "b", "a@x.io"))!,
    );
    expect(withEmail.auths["ghcr.io"]!.email).toBe("a@x.io");
  });

  test("merges multiple registries into one auths map", () => {
    const auths = buildAuths([
      { registry: "docker.io", username: "u1", password: "p1" },
      { registry: "ghcr.io", username: "u2", password: "p2" },
    ]);
    expect(Object.keys(auths).sort()).toEqual([DOCKER_HUB_KEY, "ghcr.io"].sort());
    expect(base64Decode(auths["ghcr.io"]!.auth)).toBe("u2:p2");
  });
});

// --- dockerconfigjsonToSecret ----------------------------------------------

describe("dockerconfigjsonToSecret", () => {
  test("produces a managed-by-labeled dockerconfigjson Secret", () => {
    const secret = dockerconfigjsonToSecret(
      "docker.io",
      "alice",
      "tok",
      "rigel-dockerhub",
      "default",
    );
    expect(secret.apiVersion).toBe("v1");
    expect(secret.kind).toBe("Secret");
    expect(secret.type).toBe(DOCKERCONFIGJSON_TYPE);
    expect(secret.metadata.name).toBe("rigel-dockerhub");
    expect(secret.metadata.namespace).toBe("default");
    expect(secret.metadata.labels?.[MANAGED_BY_LABEL]).toBe(MANAGED_BY_VALUE);
    expect(typeof secret.data?.[DOCKERCONFIGJSON_KEY]).toBe("string");
  });
});

// --- parse + extract for display -------------------------------------------

describe("extractRegistryFromSecret", () => {
  function secretFrom(
    registry: string,
    username: string,
    password: string,
    overrides: Partial<Secret> = {},
  ): Secret {
    return {
      metadata: { name: "s", namespace: "default", uid: "u" },
      type: DOCKERCONFIGJSON_TYPE,
      data: { [DOCKERCONFIGJSON_KEY]: buildDockerConfigJson(registry, username, password) },
      ...overrides,
    };
  }

  test("reads registry + username back for display, never the password", () => {
    const got = extractRegistryFromSecret(secretFrom("ghcr.io", "alice", "supersecret"));
    expect(got).toEqual({ registry: "ghcr.io", username: "alice" });
    // The returned object must not carry the password under any field.
    expect(JSON.stringify(got)).not.toContain("supersecret");
  });

  test("surfaces the canonical Hub key as friendly docker.io", () => {
    expect(extractRegistryFromSecret(secretFrom("docker.io", "bob", "pw"))).toEqual({
      registry: "docker.io",
      username: "bob",
    });
  });

  test("falls back to the user half of `auth` when username is absent", () => {
    const json = JSON.stringify({
      auths: { "ghcr.io": { auth: base64Encode("carol:pw") } },
    });
    const secret: Secret = {
      metadata: { name: "s", namespace: "default", uid: "u" },
      type: DOCKERCONFIGJSON_TYPE,
      data: { [DOCKERCONFIGJSON_KEY]: base64Encode(json) },
    };
    expect(extractRegistryFromSecret(secret)).toEqual({ registry: "ghcr.io", username: "carol" });
  });

  test("returns null for non-dockerconfigjson secrets", () => {
    expect(
      extractRegistryFromSecret({
        metadata: { name: "s", namespace: "default", uid: "u" },
        type: "Opaque",
        data: { foo: base64Encode("bar") },
      }),
    ).toBeNull();
  });

  test("returns null when the payload is missing or malformed", () => {
    expect(
      extractRegistryFromSecret({
        metadata: { name: "s", namespace: "default", uid: "u" },
        type: DOCKERCONFIGJSON_TYPE,
      }),
    ).toBeNull();
    expect(
      extractRegistryFromSecret({
        metadata: { name: "s", namespace: "default", uid: "u" },
        type: DOCKERCONFIGJSON_TYPE,
        data: { [DOCKERCONFIGJSON_KEY]: base64Encode("not json") },
      }),
    ).toBeNull();
    // valid JSON but no auth entries
    expect(
      extractRegistryFromSecret({
        metadata: { name: "s", namespace: "default", uid: "u" },
        type: DOCKERCONFIGJSON_TYPE,
        data: { [DOCKERCONFIGJSON_KEY]: base64Encode(JSON.stringify({ auths: {} })) },
      }),
    ).toBeNull();
  });
});

describe("displayRegistry", () => {
  test("maps the Hub key to docker.io, passes others through", () => {
    expect(displayRegistry(DOCKER_HUB_KEY)).toBe("docker.io");
    expect(displayRegistry("ghcr.io")).toBe("ghcr.io");
  });
});

describe("isValidDNS1123Subdomain", () => {
  test("accepts valid names", () => {
    for (const n of ["rigel-dockerhub", "a", "a.b.c", "reg-1"]) {
      expect(isValidDNS1123Subdomain(n)).toBe(true);
    }
  });
  test("rejects invalid names", () => {
    for (const n of ["", "Rigel", "-bad", "bad-", "under_score", "a".repeat(254)]) {
      expect(isValidDNS1123Subdomain(n)).toBe(false);
    }
  });
});
