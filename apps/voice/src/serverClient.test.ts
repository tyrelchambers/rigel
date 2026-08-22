import { describe, expect, test, vi } from "vitest";
import { createServerClient, VoiceNotConfiguredError } from "./serverClient.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
}

const BASE = "http://127.0.0.1:4321";

describe("createServerClient", () => {
  test("agentConfig sends the worker + session headers", async () => {
    const f = fakeFetch(200, { url: "wss://x", token: "t", model: "m", sttModel: "deepgram/nova-3", ttsModel: "cartesia/sonic-2", apiKey: "k", apiSecret: "s", openrouterApiKey: "o" });
    const c = createServerClient(BASE, "sess", "wt", f);
    const cfg = await c.agentConfig();
    expect(cfg.url).toBe("wss://x");
    const [urlArg, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(urlArg).toBe(`${BASE}/api/voice/agent-config`);
    expect((init as RequestInit).headers).toMatchObject({
      "x-rigel-session": "sess",
      "x-rigel-voice-worker": "wt",
    });
  });

  test("agentConfig throws VoiceNotConfiguredError naming the missing fields on 409", async () => {
    const f = fakeFetch(409, { error: "voice is not configured", missing: ["apiSecret", "openrouterApiKey"] });
    const c = createServerClient(BASE, "sess", "wt", f);
    const err = await c.agentConfig().catch((e) => e);
    expect(err).toBeInstanceOf(VoiceNotConfiguredError);
    expect((err as VoiceNotConfiguredError).missing).toEqual(["apiSecret", "openrouterApiKey"]);
    expect((err as Error).message).toMatch(/apiSecret, openrouterApiKey/);
  });

  test("previewAction posts to /api/action?preview=1 with the context header", async () => {
    const f = fakeFetch(200, { command: ["kubectl", "--context", "prod", "rollout", "restart", "deployment/web"] });
    const c = createServerClient(BASE, "sess", "wt", f);
    const cmd = await c.previewAction({ kind: "restart", label: "Restart web", name: "web" }, "prod");
    expect(cmd.join(" ")).toContain("rollout restart");
    const [urlArg, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(urlArg).toBe(`${BASE}/api/action?preview=1`);
    expect((init as RequestInit).headers).toMatchObject({ "X-Rigel-Context": "prod" });
  });

  test("repoLink asks the server whether a workload is managed from Git", async () => {
    const link = { source: "default-web-82b3ade", repo: "owner/repo", repoName: "owner-repo", repoURL: "https://github.com/owner/repo", branch: "main", path: "k8s" };
    const f = fakeFetch(200, { linked: true, link });
    const c = createServerClient(BASE, "sess", "wt", f);
    const res = await c.repoLink({ kind: "statefulset", name: "web", namespace: "shop" }, "prod");
    expect(res.linked).toBe(true);
    expect(res.link).toEqual(link);
    const [urlArg, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(urlArg)).toBe(`${BASE}/api/git/link?namespace=shop&deployment=web&kind=statefulset`);
    expect((init as RequestInit).headers).toMatchObject({
      "x-rigel-voice-worker": "wt",
      "X-Rigel-Context": "prod",
    });
  });

  test("repoLink reports an unlinked workload rather than throwing", async () => {
    const c = createServerClient(BASE, "sess", "wt", fakeFetch(200, { linked: false, link: null }));
    expect((await c.repoLink({ name: "web" }, null)).linked).toBe(false);
  });

  test("proposeFix posts the intent, never a file, and never a dry run", async () => {
    const f = fakeFetch(200, { ok: true, prUrl: "https://github.com/owner/repo/pull/7", number: 7 });
    const c = createServerClient(BASE, "sess", "wt", f);
    const res = await c.proposeFix(
      {
        kind: "proposeRepoFix",
        label: "Open a PR",
        source: "default-web-82b3ade",
        title: "Annotate web",
        body: "asked for over voice",
        name: "web",
        namespace: "shop",
        resourceKind: "statefulset",
        edit: { op: "annotate", annotations: { "example.com/owner": "platform" } },
      },
      "prod",
    );
    expect(res.prUrl).toBe("https://github.com/owner/repo/pull/7");
    const [urlArg, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(urlArg).toBe(`${BASE}/api/git/propose-fix`);
    const sent = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(sent).toEqual({
      source: "default-web-82b3ade",
      title: "Annotate web",
      body: "asked for over voice",
      name: "web",
      namespace: "shop",
      resourceKind: "statefulset",
      edit: { op: "annotate", annotations: { "example.com/owner": "platform" } },
    });
    expect(sent.dryRun).toBeUndefined();
    expect(sent.filePath).toBeUndefined();
  });

  test("proposeFix throws the server's own reason, so the refusal can be spoken", async () => {
    const c = createServerClient(BASE, "sess", "wt", fakeFetch(404, { error: "unknown source" }));
    await expect(
      c.proposeFix({ kind: "proposeRepoFix", label: "x", source: "s", title: "t", name: "web", edit: { op: "scale", replicas: 2 } }, null),
    ).rejects.toThrow("unknown source");
  });

  test("relatedResources asks the server, which knows how the cluster labels things", async () => {
    const f = fakeFetch(200, {
      name: "reddex-deploy",
      namespace: "default",
      resources: [
        { kind: "deployment", name: "reddex-deploy", namespace: "default" },
        { kind: "service", name: "reddex-deploy", namespace: "default" },
        { kind: "ingress", name: "reddex-ingress", namespace: "default" },
      ],
    });
    const c = createServerClient(BASE, "sess", "wt", f);
    const res = await c.relatedResources("reddex-deploy", "default", "prod");
    expect(res.resources).toHaveLength(3);
    const [urlArg, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(urlArg)).toBe(`${BASE}/api/discover?name=reddex-deploy&namespace=default`);
    expect((init as RequestInit).headers).toMatchObject({ "X-Rigel-Context": "prod" });
  });

  test("relatedResources throws the server's reason", async () => {
    const c = createServerClient(BASE, "sess", "wt", fakeFetch(422, { error: "missing name" }));
    await expect(c.relatedResources("", "default", null)).rejects.toThrow("missing name");
  });

  test("reportUnsupported records what was asked", async () => {
    const f = fakeFetch(200, { ok: true });
    const c = createServerClient(BASE, "sess", "wt", f);
    await c.reportUnsupported("add manifests for reddex-deploy to the repo", "prod");
    const [urlArg, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(urlArg).toBe(`${BASE}/api/ai/unsupported`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      request: "add manifests for reddex-deploy to the repo",
    });
  });

  test("runAction posts the action and returns the kubectl result", async () => {
    const ok = createServerClient(BASE, "sess", "wt", fakeFetch(200, { code: 0, stdout: "restarted", stderr: "" }));
    expect((await ok.runAction({ kind: "restart", label: "x", name: "web" }, null)).code).toBe(0);
    const bad = createServerClient(BASE, "sess", "wt", fakeFetch(422, {}));
    await expect(bad.runAction({ kind: "restart", label: "x", name: "web" }, null)).rejects.toThrow("422");
  });
});
