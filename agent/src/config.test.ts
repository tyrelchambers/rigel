import { describe, expect, test, vi } from "vitest";
import { resolveFixRunnerImage, type Config } from "./config.js";
import type { KubectlResult } from "./kubectl.js";

const ok = (stdout: string): KubectlResult => ({ stdout, stderr: "", code: 0 });
const fail = (): KubectlResult => ({ stdout: "", stderr: "forbidden", code: 1 });

// resolveFixRunnerImage reads only stateNamespace + fixRunnerImage; the rest of
// Config is irrelevant here, so cast a minimal object.
function cfg(over: Partial<Config> = {}): Config {
  return { stateNamespace: "default", fixRunnerImage: "ghcr.io/me/rigel-assistant:env-default", ...over } as Config;
}

describe("resolveFixRunnerImage", () => {
  test("returns the agent's OWN running image from the pod self-lookup", async () => {
    const kubectl = vi.fn(async () => ok("ghcr.io/me/rigel-assistant:sha-abc123"));
    const log = vi.fn();
    const image = await resolveFixRunnerImage(cfg(), { kubectl, hostname: "rigel-assistant-7d9f-xyz", log });
    expect(image).toBe("ghcr.io/me/rigel-assistant:sha-abc123");
    // It looked up its own pod by HOSTNAME in the state namespace.
    expect(kubectl).toHaveBeenCalledWith([
      "get", "pod", "rigel-assistant-7d9f-xyz", "-n", "default", "-o", "jsonpath={.spec.containers[0].image}",
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  test("falls back to the env image when HOSTNAME is unset (and logs)", async () => {
    const kubectl = vi.fn();
    const log = vi.fn();
    const image = await resolveFixRunnerImage(cfg(), { kubectl, hostname: undefined, log });
    expect(image).toBe("ghcr.io/me/rigel-assistant:env-default");
    expect(kubectl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  test("falls back to the env image when the self-lookup fails (non-zero exit)", async () => {
    const kubectl = vi.fn(async () => fail());
    const log = vi.fn();
    const image = await resolveFixRunnerImage(cfg(), { kubectl, hostname: "pod", log });
    expect(image).toBe("ghcr.io/me/rigel-assistant:env-default");
    expect(log).toHaveBeenCalledOnce();
  });

  test("falls back to the env image when the lookup returns an empty image", async () => {
    const kubectl = vi.fn(async () => ok("   "));
    const log = vi.fn();
    const image = await resolveFixRunnerImage(cfg(), { kubectl, hostname: "pod", log });
    expect(image).toBe("ghcr.io/me/rigel-assistant:env-default");
    expect(log).toHaveBeenCalledOnce();
  });

  test("falls back to the env image when kubectl THROWS (spawn error)", async () => {
    const kubectl = vi.fn(async () => { throw new Error("spawn kubectl ENOENT"); });
    const log = vi.fn();
    const image = await resolveFixRunnerImage(cfg(), { kubectl, hostname: "pod", log });
    expect(image).toBe("ghcr.io/me/rigel-assistant:env-default");
    expect(log).toHaveBeenCalledOnce();
  });
});
