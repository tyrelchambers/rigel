import { describe, expect, test } from "vitest";
import type { Secret } from "@helmsman/k8s";
import {
  buildDockerConfigJson,
  base64Encode,
  base64Decode,
  DOCKERCONFIGJSON_TYPE,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
} from "@helmsman/k8s";
import {
  accountsFromSecrets,
  accountId,
  validateForm,
  isFormValid,
  emptyForm,
  previewYAML,
  applyYAML,
  setDefaultId,
  defaultIdAfterAdd,
  defaultIdAfterDelete,
  type AccountForm,
} from "./accountsLogic";

function dockerSecret(
  name: string,
  namespace: string,
  registry: string,
  username: string,
  password: string,
  managed = true,
): Secret {
  return {
    metadata: {
      name,
      namespace,
      uid: `${namespace}/${name}`,
      labels: managed ? { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE } : {},
    },
    type: DOCKERCONFIGJSON_TYPE,
    data: { ".dockerconfigjson": buildDockerConfigJson(registry, username, password) },
  };
}

// --- List derivation -------------------------------------------------------

describe("accountsFromSecrets", () => {
  test("maps dockerconfigjson secrets to accounts with registry + username", () => {
    const map: Record<string, Secret> = {
      "helmsman-dockerhub": dockerSecret("helmsman-dockerhub", "default", "docker.io", "alice", "tok"),
    };
    const accounts = accountsFromSecrets(map, null);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      registry: "docker.io",
      username: "alice",
      secretName: "helmsman-dockerhub",
      sourceNamespace: "default",
      managed: true,
      isDefault: false,
    });
  });

  test("ignores non-dockerconfigjson and undecodable secrets", () => {
    const map: Record<string, Secret> = {
      opaque: { metadata: { name: "opaque", namespace: "default", uid: "x" }, type: "Opaque", data: { a: base64Encode("b") } },
      tls: { metadata: { name: "tls", namespace: "default", uid: "y" }, type: "kubernetes.io/tls", data: {} },
      garbage: {
        metadata: { name: "garbage", namespace: "default", uid: "z" },
        type: DOCKERCONFIGJSON_TYPE,
        data: { ".dockerconfigjson": base64Encode("not json") },
      },
      good: dockerSecret("good", "default", "ghcr.io", "bob", "pw"),
    };
    const accounts = accountsFromSecrets(map, null);
    expect(accounts.map((a) => a.secretName)).toEqual(["good"]);
  });

  test("flags referenced (unmanaged) secrets", () => {
    const map: Record<string, Secret> = {
      ref: dockerSecret("ref", "default", "quay.io", "carol", "pw", false),
    };
    expect(accountsFromSecrets(map, null)[0]!.managed).toBe(false);
  });

  test("marks the row whose id matches defaultId", () => {
    const map: Record<string, Secret> = {
      a: dockerSecret("a", "default", "docker.io", "u", "p"),
      b: dockerSecret("b", "default", "ghcr.io", "u", "p"),
    };
    const id = accountId("b", "default");
    const accounts = accountsFromSecrets(map, id);
    expect(accounts.find((x) => x.secretName === "b")!.isDefault).toBe(true);
    expect(accounts.find((x) => x.secretName === "a")!.isDefault).toBe(false);
  });

  test("never exposes the password in the derived account", () => {
    const map: Record<string, Secret> = {
      s: dockerSecret("s", "default", "ghcr.io", "alice", "topsecret"),
    };
    expect(JSON.stringify(accountsFromSecrets(map, null))).not.toContain("topsecret");
  });

  test("sorts by namespace then secret name", () => {
    const map: Record<string, Secret> = {
      z: dockerSecret("z", "alpha", "docker.io", "u", "p"),
      a: dockerSecret("a", "beta", "docker.io", "u", "p"),
      m: dockerSecret("m", "alpha", "docker.io", "u", "p"),
    };
    expect(accountsFromSecrets(map, null).map((x) => `${x.sourceNamespace}/${x.secretName}`)).toEqual([
      "alpha/m",
      "alpha/z",
      "beta/a",
    ]);
  });
});

// --- Validation ------------------------------------------------------------

describe("validateForm", () => {
  test("create mode: requires registry, secretName, namespace, token", () => {
    const form: AccountForm = { ...emptyForm(), registry: "  ", secretName: " ", namespace: "", password: "" };
    const errors = validateForm(form);
    expect(errors.registry).toBeDefined();
    expect(errors.secretName).toBeDefined();
    expect(errors.namespace).toBeDefined();
    expect(errors.password).toBeDefined();
  });

  test("create mode: a valid form passes", () => {
    expect(isFormValid({ ...emptyForm(), username: "alice", password: "tok" })).toBe(true);
  });

  test("reference mode: token is NOT required", () => {
    const form: AccountForm = { ...emptyForm(), mode: "reference", password: "", secretName: "existing-secret" };
    expect(validateForm(form).password).toBeUndefined();
    expect(isFormValid(form)).toBe(true);
  });

  test("rejects a non-DNS-1123 secret name", () => {
    expect(validateForm({ ...emptyForm(), password: "t", secretName: "Bad_Name" }).secretName).toBeDefined();
  });
});

// --- YAML preview (masking) + apply ----------------------------------------

describe("previewYAML / applyYAML", () => {
  const form: AccountForm = { ...emptyForm(), username: "alice", password: "supersecret" };

  test("preview masks .dockerconfigjson and never leaks the token", () => {
    const yaml = previewYAML(form);
    expect(yaml).toContain(".dockerconfigjson: [hidden]");
    expect(yaml).not.toContain("supersecret");
    expect(yaml).not.toContain("alice:supersecret");
    expect(yaml).toContain(`${MANAGED_BY_LABEL}: ${MANAGED_BY_VALUE}`);
    expect(yaml).toContain("type: kubernetes.io/dockerconfigjson");
  });

  test("apply YAML carries the real base64 credential", () => {
    const yaml = applyYAML(form);
    expect(yaml).not.toContain("[hidden]");
    const line = yaml.split("\n").find((l) => l.includes(".dockerconfigjson:"))!;
    const b64 = line.split(".dockerconfigjson:")[1]!.trim();
    const decoded = base64Decode(b64)!;
    expect(decoded).toContain("alice");
    // round-trips to the credential the kubelet expects
    expect(decoded).toContain(base64Encode("alice:supersecret"));
  });
});

// --- Default toggling ------------------------------------------------------

describe("default-id helpers", () => {
  test("setDefaultId returns the target (unsetting any prior default)", () => {
    expect(setDefaultId("default/a", "default/b")).toBe("default/b");
  });

  test("defaultIdAfterAdd: becomes default when toggled", () => {
    expect(defaultIdAfterAdd("default/a", "default/b", true, 1)).toBe("default/b");
  });

  test("defaultIdAfterAdd: becomes default when it is the only account", () => {
    expect(defaultIdAfterAdd(null, "default/a", false, 0)).toBe("default/a");
  });

  test("defaultIdAfterAdd: keeps prior default otherwise", () => {
    expect(defaultIdAfterAdd("default/a", "default/b", false, 1)).toBe("default/a");
  });

  test("defaultIdAfterDelete: clears the default only when the removed row was default", () => {
    expect(defaultIdAfterDelete("default/a", "default/a")).toBeNull();
    expect(defaultIdAfterDelete("default/a", "default/b")).toBe("default/a");
  });
});
