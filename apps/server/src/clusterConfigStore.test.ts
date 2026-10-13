import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS_CONFIG_KEY,
  CLAUDE_TOKEN_KEY,
  emptyUserConfigData,
} from "@rigel/k8s/src/userConfig";
import {
  __resetClusterConfigCache,
  __setClusterConfigIO,
  __useFakeClusterConfig,
  readUserConfig,
  writeUserConfig,
  type FakeClusterConfig,
} from "./clusterConfigStore";

const CTX = "test-cluster";
let fake: FakeClusterConfig;
let home: string;
const ORIG_HOME = process.env.HOME;
const ORIG_USER_DATA = process.env.RIGEL_USER_DATA_DIR;

beforeEach(async () => {
  fake = __useFakeClusterConfig();
  home = await mkdtemp(join(tmpdir(), "rigel-cluster-config-"));
  process.env.HOME = home;
  delete process.env.RIGEL_USER_DATA_DIR;
  await mkdir(join(home, ".claude"), { recursive: true });
});

afterEach(() => {
  __setClusterConfigIO(null);
  __resetClusterConfigCache();
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USER_DATA === undefined) delete process.env.RIGEL_USER_DATA_DIR;
  else process.env.RIGEL_USER_DATA_DIR = ORIG_USER_DATA;
});

describe("readUserConfig", () => {
  it("an absent Secret reads as connected-but-empty, which is not the same as unavailable", async () => {
    const read = await readUserConfig(CTX);
    expect(read.state).toBe("ok");
    expect(read.data).toEqual(emptyUserConfigData());
  });

  it("an unreachable cluster reads as unavailable and carries the reason", async () => {
    fake.reachable = false;
    const read = await readUserConfig(CTX);
    expect(read.state).toBe("unavailable");
    expect(read.message).toMatch(/connection to the server/);
  });

  it("caches per context: a repeat read does not hit the API server again", async () => {
    await readUserConfig(CTX);
    await readUserConfig(CTX);
    await readUserConfig("other");
    expect(fake.reads).toEqual([CTX, "other"]);
  });

  it("coalesces reads while the cluster is down, then retries once the failure expires", async () => {
    vi.useFakeTimers();
    try {
      fake.reachable = false;
      expect((await readUserConfig(CTX)).state).toBe("unavailable");
      expect((await readUserConfig(CTX)).state).toBe("unavailable");
      expect(fake.reads).toHaveLength(1);

      fake.reachable = true;
      vi.advanceTimersByTime(5_001);
      expect((await readUserConfig(CTX)).state).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("decodes what the Secret holds", async () => {
    fake.secrets.set(CTX, { ...emptyUserConfigData(), [CLAUDE_TOKEN_KEY]: "sk-ant-oat-x" });
    expect((await readUserConfig(CTX)).data[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat-x");
  });
});

describe("writeUserConfig", () => {
  it("merges, invalidates the cache, and serves the new value without a re-read", async () => {
    await readUserConfig(CTX);
    await writeUserConfig(CTX, () => ({ [CLAUDE_TOKEN_KEY]: "tok" }));
    const read = await readUserConfig(CTX);
    expect(read.data[CLAUDE_TOKEN_KEY]).toBe("tok");
    expect(fake.reads).toEqual([CTX]);
  });

  it("refuses to write when the cluster is unavailable", async () => {
    fake.reachable = false;
    await expect(writeUserConfig(CTX, () => ({ [CLAUDE_TOKEN_KEY]: "tok" }))).rejects.toThrow(
      /no cluster to save to/,
    );
  });

  it("surfaces an apply failure rather than reporting a save that did not land", async () => {
    await readUserConfig(CTX);
    __setClusterConfigIO({
      read: async () => ({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" }),
      write: async () => ({ code: 1, stdout: "", stderr: "secrets is forbidden" }),
      log: () => {},
    });
    __resetClusterConfigCache();
    await expect(writeUserConfig(CTX, () => ({ [CLAUDE_TOKEN_KEY]: "tok" }))).rejects.toThrow(
      /forbidden/,
    );
  });

  it("serializes overlapping writes so neither update is lost", async () => {
    await Promise.all([
      writeUserConfig(CTX, (current) => ({
        [AGENTS_CONFIG_KEY]: JSON.stringify({ ...JSON.parse(current[AGENTS_CONFIG_KEY] || "{}"), activeAgentId: "codex" }),
      })),
      writeUserConfig(CTX, (current) => ({
        [AGENTS_CONFIG_KEY]: JSON.stringify({
          ...JSON.parse(current[AGENTS_CONFIG_KEY] || "{}"),
          agents: { codex: { authMethod: "apiKey" } },
        }),
      })),
    ]);
    const stored = JSON.parse(fake.secrets.get(CTX)![AGENTS_CONFIG_KEY]);
    expect(stored).toEqual({ activeAgentId: "codex", agents: { codex: { authMethod: "apiKey" } } });
  });
});

describe("migration from local files", () => {
  async function writeLocal(rel: string[], contents: string): Promise<string> {
    const path = join(home, ...rel);
    await mkdir(join(home, ...rel.slice(0, -1)), { recursive: true });
    await writeFile(path, contents, { mode: 0o600 });
    return path;
  }

  it("pushes the local files into a cluster with no Secret, then removes them", async () => {
    const agents = await writeLocal(
      [".claude", "rigel-agents.json"],
      JSON.stringify({ activeAgentId: "codex", agents: { codex: { authMethod: "apiKey", apiKey: "sk-c" } } }),
    );
    const token = await writeLocal([".claude", "rigel-oauth-token"], "sk-ant-oat-local");

    const read = await readUserConfig(CTX);
    expect(read.state).toBe("ok");
    expect(JSON.parse(read.data[AGENTS_CONFIG_KEY]).agents.codex.apiKey).toBe("sk-c");
    expect(read.data[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat-local");

    for (const path of [agents, token]) {
      await expect(readFile(path, "utf8")).rejects.toThrow();
    }
    expect(fake.logs.filter((l) => l.includes("moved local config"))).toHaveLength(1);
  });

  it("does not push again once the files have been drained", async () => {
    await writeLocal([".claude", "rigel-oauth-token"], "sk-ant-oat-local");
    await readUserConfig(CTX);
    __resetClusterConfigCache();
    fake.secrets.delete(CTX);
    const again = await readUserConfig(CTX);
    expect(again.data[CLAUDE_TOKEN_KEY]).toBe("");
    expect(fake.writes).toHaveLength(1);
  });

  it("leaves a value it cannot decrypt behind, keeps the file, and says so", async () => {
    await writeLocal([".claude", "rigel-agents.json"], JSON.stringify({ activeAgentId: "codex" }));
    const token = await writeLocal([".claude", "rigel-oauth-token"], "enc:v1:bm90LWRlY3J5cHRhYmxl");
    const read = await readUserConfig(CTX);
    expect(JSON.parse(read.data[AGENTS_CONFIG_KEY])).toEqual({ activeAgentId: "codex" });
    expect(read.data[CLAUDE_TOKEN_KEY]).toBe("");
    expect(await readFile(token, "utf8")).toContain("enc:v1:");
    expect(fake.logs.join("\n")).toMatch(/claudeToken could not be decrypted/);
  });

  it("never overwrites a key the cluster already has, and drains the file", async () => {
    const token = await writeLocal([".claude", "rigel-oauth-token"], "sk-ant-oat-local");
    fake.secrets.set(CTX, { ...emptyUserConfigData(), [CLAUDE_TOKEN_KEY]: "sk-ant-oat-cluster" });
    const read = await readUserConfig(CTX);
    expect(read.data[CLAUDE_TOKEN_KEY]).toBe("sk-ant-oat-cluster");
    await expect(readFile(token, "utf8")).rejects.toThrow();
  });

  it("keeps the local files when the push fails", async () => {
    const token = await writeLocal([".claude", "rigel-oauth-token"], "sk-ant-oat-local");
    __setClusterConfigIO({
      read: async () => ({ code: 1, stdout: "", stderr: 'Error from server (NotFound): secrets "rigel-user-config" not found' }),
      write: async () => ({ code: 1, stdout: "", stderr: "secrets is forbidden" }),
      log: (m) => fake.logs.push(m),
    });
    __resetClusterConfigCache();
    const read = await readUserConfig(CTX);
    expect(read.state).toBe("ok");
    expect(read.data[CLAUDE_TOKEN_KEY]).toBe("");
    expect(await readFile(token, "utf8")).toContain("sk-ant-oat-local");
    expect(fake.logs.join("\n")).toMatch(/could not move local config/);
  });
});
