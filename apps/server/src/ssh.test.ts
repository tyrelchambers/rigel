import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listSshConfigAliases,
  parseSshConfig,
  readEnabledSshHosts,
  setEnabledSshHosts,
  sshActionArgv,
  validateSshAction,
} from "./ssh";

describe("parseSshConfig", () => {
  it("collects concrete aliases and includes, skipping patterns", () => {
    const text = `
# comment
Host web-1 web-2
  HostName 10.0.0.1
Host *.internal !bad
Host=nas
Include config.d/*
Match host foo
  User x
`;
    expect(parseSshConfig(text)).toEqual({ aliases: ["web-1", "web-2", "nas"], includes: ["config.d/*"] });
  });

  it("drops trailing comments and keeps a quoted alias whole", () => {
    const text = 'Host web-1 # the edge box\nHost "my box" lab\nInclude extra # more hosts\n';
    expect(parseSshConfig(text)).toEqual({ aliases: ["web-1", "my box", "lab"], includes: ["extra"] });
  });
});

describe("listSshConfigAliases", () => {
  it("follows Include globs relative to the ssh dir and dedupes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rigel-ssh-"));
    await mkdir(join(dir, "config.d"));
    await writeFile(join(dir, "config"), "Host web-1\nInclude config.d/*\n");
    await writeFile(join(dir, "config.d", "lab"), "Host nas web-1\n");
    expect(await listSshConfigAliases(join(dir, "config"), dir)).toEqual(["web-1", "nas"]);
  });

  it("returns [] when the config is missing", async () => {
    expect(await listSshConfigAliases("/nonexistent/config", "/nonexistent")).toEqual([]);
  });
});

describe("enabled host store", () => {
  it("round-trips and drops aliases no longer in the config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rigel-ssh-store-"));
    const file = join(dir, "ssh-hosts.json");
    await setEnabledSshHosts(["web-1", "gone"], file);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ enabled: ["web-1", "gone"] });
    expect(await readEnabledSshHosts(["web-1", "nas"], file)).toEqual(["web-1"]);
  });

  it("reads [] when the file is missing or corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rigel-ssh-store-"));
    expect(await readEnabledSshHosts(["web-1"], join(dir, "none.json"))).toEqual([]);
    await writeFile(join(dir, "bad.json"), "{");
    expect(await readEnabledSshHosts(["web-1"], join(dir, "bad.json"))).toEqual([]);
  });
});

describe("sshActionArgv", () => {
  it("ends options before the host so the command can't inject flags", () => {
    expect(sshActionArgv("web-1", "systemctl restart k3s")).toEqual([
      "ssh", "-T", "-o", "BatchMode=yes", "--", "web-1", "systemctl restart k3s",
    ]);
  });
});

describe("validateSshAction", () => {
  const enabled = ["web-1"];

  it("returns the trimmed host and command for an enabled host", () => {
    expect(validateSshAction({ host: " web-1 ", command: " uptime " }, enabled)).toEqual({ host: "web-1", command: "uptime" });
  });

  it("needs both host and command", () => {
    expect(validateSshAction({ host: "web-1" }, enabled)).toEqual({ error: "sshCommand needs host and command" });
    expect(validateSshAction({ command: "uptime" }, enabled)).toEqual({ error: "sshCommand needs host and command" });
  });

  it("refuses a command that starts with a dash", () => {
    expect(validateSshAction({ host: "web-1", command: "-oProxyCommand=sh" }, enabled)).toEqual({
      error: "sshCommand command can't start with -",
    });
  });

  it("refuses a host the user has not enabled", () => {
    expect(validateSshAction({ host: "nas", command: "uptime" }, enabled)).toEqual({
      error: "nas isn't enabled in Settings > AI agents > SSH hosts",
    });
  });
});
