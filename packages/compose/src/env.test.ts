import { describe, it, expect } from "vitest";
import { isSecretEnvKey } from "./env";

describe("isSecretEnvKey", () => {
  it("flags password/secret/token/apikey/_key keys, case-insensitive", () => {
    for (const k of ["POSTGRES_PASSWORD", "API_TOKEN", "MY_SECRET", "APIKEY", "TLS_KEY", "db_password"]) {
      expect(isSecretEnvKey(k)).toBe(true);
    }
  });
  it("does not flag ordinary keys", () => {
    for (const k of ["HOST", "PORT", "KEYCLOAK_URL", "LOG_LEVEL"]) {
      expect(isSecretEnvKey(k)).toBe(false);
    }
  });
});
