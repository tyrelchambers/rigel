import { describe, expect, it } from "vitest";
import { parseShell } from "./shellWords";
import { classifyShellSsh, classifySsh, parseSshHostsEnv } from "./sshPolicy";

const HOSTS = ["web-1", "nas"];
const decide = (argv: string[]) => classifySsh(argv, HOSTS).decision;
const remote = (cmd: string) => decide(["web-1", cmd]);

describe("classifySsh: remote reads", () => {
  it.each([
    "uptime",
    "df -h",
    "journalctl -u nginx -n 200 --no-pager",
    "sudo journalctl -u k3s --since '1 hour ago'",
    "sudo -n systemctl status k3s",
    "systemctl",
    "systemctl list-units --failed",
    "cat /var/log/syslog | grep -i error | tail -n 50",
    "docker ps -a",
    "docker logs --tail 100 api",
    "docker compose ps",
    "docker stats --no-stream",
    "crictl ps",
    "kubectl get pods -A",
    "kubectl -n kube-system get pods",
    "kubectl --insecure-skip-tls-verify get nodes",
    "kubectl get --raw /api/v1/nodes",
    "kubectl get --raw=/api/v1/nodes",
    "k3s kubectl get nodes",
    "ip addr show",
    "ip route",
    "ss -tlnp",
    "ping -c 3 1.1.1.1",
    "top -bn1",
    "find /var/log -name '*.log' -mtime -1",
    "zpool status",
    "zfs list",
    "smartctl -a /dev/nvme0",
    "ls -la /etc 2>/dev/null",
    "dmesg -T 2>&1 | tail",
    "bash -c 'uptime && df -h'",
    "date +%s",
    "hostname",
    "vmstat 1 5",
    "true",
    "sudo -n true 2>&1 && echo yes || echo no",
    "false || echo fallback",
    "/usr/bin/uptime",
    "/bin/df -h",
    "sudo /usr/sbin/zpool status",
    "ip -br -c addr",
    "ip -4 route show",
    "systemctl --failed --no-pager",
    "hostname -f",
    "docker container ls -a",
    "uniq -c",
    "kubectl auth can-i list pods",
    "kubectl rollout status deploy/api",
    "kubectl config current-context",
    "kubectl events -A",
    "k3s kubectl describe node web-1",
  ])("%s is a read", (cmd) => {
    expect(remote(cmd)).toBe("read");
  });

  it("joins multiple remote args like ssh does", () => {
    expect(decide(["web-1", "journalctl", "-u", "nginx"])).toBe("read");
  });

  it("accepts user@alias and allowed options", () => {
    expect(decide(["-p", "2222", "-i", "~/.ssh/id", "-o", "ConnectTimeout=5", "root@web-1", "uptime"])).toBe("read");
    expect(decide(["-vT", "web-1", "uptime"])).toBe("read");
    expect(decide(["-oConnectTimeout=5", "web-1", "uptime"])).toBe("read");
  });
});

describe("classifySsh: needs approval", () => {
  it.each([
    "systemctl restart k3s",
    "rm -rf /tmp/x",
    "sed -i s/a/b/ /etc/hosts",
    "awk 'BEGIN{system(\"id\")}'",
    "cat x > /etc/y",
    "echo hi >> /tmp/f",
    "tee /tmp/f",
    "echo $(id)",
    "tail -f /var/log/syslog",
    "journalctl -fu nginx",
    "journalctl --vacuum-size=100M",
    "docker restart api",
    "docker logs -f api",
    "docker stats",
    "kubectl delete pod x",
    "kubectl --field-selector get delete pod x",
    "kubectl --field-selector=x get pods",
    "kubectl rollout --field-selector status restart deploy/api",
    "ping -Ic 1.1.1.1",
    "top -bdn",
    "kubectl get secret s -o yaml",
    "kubectl get --raw /api/v1/namespaces/default/secrets",
    "kubectl get --raw=/api/v1/namespaces/default/Secrets/x",
    "kubectl get pods -w",
    "find / -name x -delete",
    "find / -exec rm {} ;",
    "sort -o out in",
    "sort --compress-program=/tmp/x big.txt",
    "dig -f /tmp/names",
    "hostname newname",
    "date -s 2020-01-01",
    "ip link set eth0 down",
    "ss -K dst 1.2.3.4",
    "ping 1.1.1.1",
    "top",
    "vmstat 1",
    "FOO=bar uptime",
    "sudo -E uptime",
    "bash",
    "bash -c 'rm -rf /'",
    "cat <<EOF",
    "smartctl -t long /dev/sda",
    "zpool scrub tank",
    "(uptime)",
    "/usr/local/bin/mystery",
    "sudo systemctl -p status restart nginx",
    "systemctl --property status restart nginx",
    "systemctl --reboot-argument status reboot",
    "timedatectl -p status set-timezone UTC",
    "hostnamectl -p status set-hostname x",
    "docker --config ps restart api",
    "docker --config stats --no-stream rm -f api",
    "docker compose --profile ps down",
    "docker compose config -o /etc/x",
    "docker compose config --output=/etc/x",
    "crictl -c ps rmp -a",
    "zpool status -c smart",
    "sudo ip -b - addr",
    "ip -batch /tmp/cmds addr",
    "ip -force -b - addr show",
    "ip -n addr show",
    "kubectl cnpg destroy pg 1",
    "k3s kubectl cnpg destroy pg 1",
    "kubectl config set-context x --namespace=y",
    "kubectl config view --raw",
    "hostname -F/tmp/x",
    "hostname --file=/tmp/x",
    "hostname -b",
    "ss -D /etc/passwd",
    "ss --diag=/tmp/x",
    "journalctl --cursor-file=/etc/passwd -n 1",
    "file -C -m /tmp/x",
    "file --compile -m /tmp/x",
    "ping -f -c 3 1.1.1.1",
    "uniq - /tmp/out",
    "uniq -- in -out",
    "/tmp/evil/uptime",
    "./uptime",
    "/usr/local/bin/uptime",
    "bash -c '/tmp/x/uptime'",
    "echo (touch /tmp/x)",
    "ls *(e:'touch /tmp/x':)",
    "sort --compress=/tmp/x big.txt",
    "sort --out=/etc/x in",
    "journalctl --vacuum-s=1M",
    "journalctl --cursor-f=/tmp/x -n 1",
    "dmesg --cle",
    "ss --dia=/tmp/x",
    "file --comp -m /tmp/x",
    "smartctl --sm=off /dev/sda",
    "toString",
    "constructor",
    "docker constructor ls",
    "kubectl cluster-info dump --output-directory=/tmp/x",
  ])("%s needs approval", (cmd) => {
    expect(remote(cmd)).toBe("approve");
  });

  it("names the host and the action block in the hint", () => {
    const v = classifySsh(["web-1", "systemctl restart nginx"], HOSTS);
    expect(v.reason).toContain("sshCommand");
    expect(v.reason).toContain("web-1");
  });
});

describe("classifySsh: denied", () => {
  it.each([
    [["prod-db", "uptime"]],
    [["root@prod-db", "uptime"]],
    [["web-1"]],
    [["-t", "web-1", "uptime"]],
    [["-tt", "web-1", "uptime"]],
    [["-L", "8080:localhost:80", "web-1", "uptime"]],
    [["-D", "1080", "web-1", "uptime"]],
    [["-A", "web-1", "uptime"]],
    [["-J", "nas", "web-1", "uptime"]],
    [["-F", "/tmp/cfg", "web-1", "uptime"]],
    [["-o", "ProxyCommand=sh -c id", "web-1", "uptime"]],
    [["-oLocalCommand=id", "web-1", "uptime"]],
    [["-o", "StrictHostKeyChecking=no", "web-1", "uptime"]],
    [["-N", "web-1"]],
    [["ssh://web-1", "uptime"]],
    [["-p"]],
    [["x -oProxyCommand=id@web-1", "uptime"]],
    [["ro;ot@web-1", "uptime"]],
    [["@web-1", "uptime"]],
  ])("%j is denied", (argv) => {
    expect(decide(argv)).toBe("deny");
  });

  it("lists the enabled hosts when the host is not enabled", () => {
    expect(classifySsh(["prod-db", "uptime"], HOSTS).reason).toContain("web-1, nas");
  });

  it("says no hosts are enabled when the list is empty", () => {
    expect(classifySsh(["web-1", "uptime"], []).reason).toContain("Settings");
  });
});

describe("classifyShellSsh", () => {
  const shell = (cmd: string) => classifyShellSsh(parseShell(cmd)!, HOSTS);

  it("allows a direct read and returns the local remainder", () => {
    const v = shell(`ssh web-1 'journalctl -u x -n 50' | grep err`);
    expect(v).toEqual({ decision: "allow", reason: expect.any(String), local: "grep err" });
  });

  it("denies a remote write with the approval hint", () => {
    const v = shell(`ssh web-1 'systemctl restart x'`);
    expect(v.decision).toBe("deny");
    expect(v.reason).toContain("sshCommand");
  });

  it.each([
    `bash -c "ssh web-1 rm -rf /"`,
    `echo web-1 | xargs -I{} ssh {} uptime`,
    `/usr/bin/ssh web-1 uptime`,
    `scp web-1:/etc/hosts .`,
    `rsync -a web-1:/x .`,
    `sftp web-1`,
    `S=ssh; $S web-1 rm x`,
    `$(echo ssh) web-1 uptime`,
  ])("%s is denied as indirect", (cmd) => {
    expect(shell(cmd).decision).toBe("deny");
  });
});

describe("parseSshHostsEnv", () => {
  it("splits and trims", () => {
    expect(parseSshHostsEnv(" web-1, nas ,,")).toEqual(["web-1", "nas"]);
    expect(parseSshHostsEnv(undefined)).toEqual([]);
  });
});
