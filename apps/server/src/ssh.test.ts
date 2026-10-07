import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  listSshConfigAliases,
  parseSshConfig,
  readEnabledSshHosts,
  setEnabledSshHosts,
  sshActionArgv,
  sshActionResponse,
  SUDO_OK_MARKER,
  SUDO_PROMPT_MARKER,
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

  it("authenticates sudo first, then detaches stdin before the command runs, inside one sh -c word", () => {
    expect(SUDO_PROMPT_MARKER).toBe("[rigel-sudo-prompt]");
    expect(SUDO_OK_MARKER).toBe("[rigel-sudo-ok]");
    expect(sshActionArgv("web-1", "apt-get upgrade -y", true)).toEqual([
      "ssh", "-T", "-o", "BatchMode=yes", "--", "web-1",
      "sh -c 'sudo -S -p '\\''[rigel-sudo-prompt]'\\'' -v && printf %s '\\''[rigel-sudo-ok]'\\'' >&2 && exec </dev/null && sudo -n -- sh -c '\\''apt-get upgrade -y'\\'''",
    ]);
  });

  describe("run through a stub sudo", () => {
    let bin: string;
    beforeAll(async () => {
      bin = await mkdtemp(join(tmpdir(), "rigel-sudo-"));
      await writeFile(
        join(bin, "sudo"),
        [
          "#!/bin/sh",
          'if [ "$1 $2 $3 $4" = "-S -p [rigel-sudo-prompt] -v" ]; then',
          '  printf "%s" "$3" >&2',
          "  IFS= read -r pw || exit 1",
          '  [ "$pw" = "hunter2" ] || exit 1',
          "  exit 0",
          "fi",
          'if [ "$1 $2" = "-n --" ]; then shift 2; exec "$@"; fi',
          "exit 8",
        ].join("\n"),
        { mode: 0o755 },
      );
    });

    const runRemote = (command: string, input: string) =>
      spawnSync("/bin/sh", ["-c", sshActionArgv("web-1", command, true).at(-1)!], {
        input,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });

    it("keeps single quotes, double quotes and newlines intact through both shell levels", () => {
      const r = runRemote(`printf '%s|' 'a b' "c'd"\necho "$((1 + 1))"`, "hunter2\n");
      expect(r.stderr.toString()).toBe("[rigel-sudo-prompt][rigel-sudo-ok]");
      expect(r.stdout.toString()).toBe("a b|c'd|2\n");
      expect(r.status).toBe(0);
    });

    it("gives the command /dev/null, never the password pipe", () => {
      const r = runRemote("cat; echo done", "hunter2\nleftover\n");
      expect(r.stdout.toString()).toBe("done\n");
      expect(r.status).toBe(0);
    });

    it("never runs the command, or says sudo passed, when sudo rejects the password", () => {
      const r = runRemote("echo ran", "wrong\n");
      expect(r.stdout.toString()).toBe("");
      expect(r.stderr.toString()).toBe("[rigel-sudo-prompt]");
      expect(r.status).not.toBe(0);
    });
  });
});

describe("validateSshAction", () => {
  const enabled = ["web-1"];

  it("returns the trimmed host and command for an enabled host", () => {
    expect(validateSshAction({ host: " web-1 ", command: " uptime " }, enabled)).toEqual({
      host: "web-1",
      command: "uptime",
      sudo: false,
    });
    expect(validateSshAction({ host: "web-1", command: "apt-get upgrade -y", sudo: true }, enabled)).toEqual({
      host: "web-1",
      command: "apt-get upgrade -y",
      sudo: true,
    });
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

  it("refuses a sudo action whose command already starts with sudo", () => {
    expect(validateSshAction({ host: "web-1", command: "sudo apt-get upgrade -y", sudo: true }, enabled)).toEqual({
      error: 'With "sudo": true, write the command without the sudo prefix; Rigel adds it.',
    });
    expect(validateSshAction({ host: "web-1", command: "sudo apt-get upgrade -y" }, enabled)).toMatchObject({
      command: "sudo apt-get upgrade -y",
    });
  });

  it("refuses a host the user has not enabled", () => {
    expect(validateSshAction({ host: "nas", command: "uptime" }, enabled)).toEqual({
      error: "nas isn't enabled in Settings > AI agents > SSH hosts",
    });
  });
});

describe("sshActionResponse (REST /api/action)", () => {
  const enabled = ["web-1"];
  const ok = { code: 0, stdout: "up 3 days\n", stderr: "" };

  it("runs a plain command and records it", async () => {
    const run = vi.fn(async () => ok);
    const record = vi.fn();
    const res = await sshActionResponse({ host: "web-1", command: "uptime" }, enabled, false, record, run);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ok);
    expect(run).toHaveBeenCalledWith("web-1", "uptime");
    expect(record).toHaveBeenCalledWith({ host: "web-1", command: "ssh -T -o BatchMode=yes -- web-1 uptime", result: ok });
  });

  it("previews a sudo command with its wrapper", async () => {
    const run = vi.fn(async () => ok);
    const res = await sshActionResponse(
      { host: "web-1", command: "apt-get upgrade -y", sudo: true }, enabled, true, vi.fn(), run,
    );

    expect(await res.json()).toEqual({ command: sshActionArgv("web-1", "apt-get upgrade -y", true) });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to execute a sudo command, which needs the password from the chat confirm dialog", async () => {
    const run = vi.fn(async () => ok);
    const record = vi.fn();
    const res = await sshActionResponse(
      { host: "web-1", command: "apt-get upgrade -y", sudo: true }, enabled, false, record, run,
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Run this from the chat confirm dialog; it needs your sudo password." });
    expect(run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("returns a validation error as 422", async () => {
    const res = await sshActionResponse({ host: "nas", command: "uptime" }, enabled, false, vi.fn(), vi.fn());
    expect(res.status).toBe(422);
  });
});
