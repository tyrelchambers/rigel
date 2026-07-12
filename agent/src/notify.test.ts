// agent/src/notify.test.ts
import { afterEach, describe, expect, test, vi } from "vitest";
import { notifyMatrix, receiveMatrix, markMatrixRead, setMatrixTyping, notifyDiscord, sendToChannel, notifyTargets } from "./notify.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

afterEach(() => vi.unstubAllGlobals());

/** A minimal RuntimeConfig with everything unconfigured; tests override just
 *  the channel fields they need. */
function rc(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    enabled: true, mode: "auto", silenced: new Set(),
    signalRecipients: [], matrix: { allowedSenders: [] },
    alertRules: [], worker: { provider: "claude", model: "m" },
    supervisor: { provider: "claude", model: "m" },
    limits: {
      pollIntervalMs: 0, maxPerResourcePerHour: 0, maxPerNight: 0,
      maxAttemptsPerIncident: 0, confirmPolls: 0, namespaces: [],
    },
    autofix: { enabled: false, scope: { projects: [] }, maxPerDay: 5 },
    digests: [], notifyAllowlist: null,
    ...over,
  } as RuntimeConfig;
}

describe("notifyMatrix", () => {
  test("PUTs an m.text message with a bearer token to the room send endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }));
    await notifyMatrix("https://hs.example/", "tok", "!room:hs", "hello");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain("https://hs.example/_matrix/client/v3/rooms/");
    expect(call.url).toContain("/send/m.room.message/");
    expect(call.init.method).toBe("PUT");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(call.init.body))).toEqual({ msgtype: "m.text", body: "hello" });
  });

  test("chunks a long message into multiple PUTs", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyMatrix("https://hs", "tok", "!r", "x".repeat(3000));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  test("never throws when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(notifyMatrix("https://hs", "tok", "!r", "hi")).resolves.toBeUndefined();
  });
});

describe("markMatrixRead", () => {
  test("POSTs to the receipt endpoint with the event id and bearer token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }));
    await markMatrixRead("https://hs.example/", "tok", "!room:hs", "$ev1");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain("/_matrix/client/v3/rooms/");
    expect(call.url).toContain("/receipt/m.read/");
    expect(call.url).toContain(encodeURIComponent("$ev1"));
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(call.init.body).toBe("{}");
  });

  test("swallows fetch rejections and resolves undefined", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(markMatrixRead("https://hs", "tok", "!r", "$ev")).resolves.toBeUndefined();
  });
});

describe("setMatrixTyping", () => {
  test("PUTs typing:true with timeout to the typing endpoint for the given userId", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }));
    await setMatrixTyping("https://hs.example/", "tok", "!room:hs", "@bot:hs", true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain("/_matrix/client/v3/rooms/");
    expect(call.url).toContain("/typing/");
    expect(call.url).toContain(encodeURIComponent("@bot:hs"));
    expect(call.init.method).toBe("PUT");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(call.init.body))).toEqual({ typing: true, timeout: 30000 });
  });

  test("PUTs typing:false (no timeout) when stopping the typing indicator", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }));
    await setMatrixTyping("https://hs.example/", "tok", "!room:hs", "@bot:hs", false);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ typing: false });
  });

  test("swallows fetch rejections and resolves undefined", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(setMatrixTyping("https://hs", "tok", "!r", "@bot:hs", true)).resolves.toBeUndefined();
  });
});

describe("receiveMatrix", () => {
  test("GETs /sync with the since cursor and returns the json", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ next_batch: "s2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await receiveMatrix("https://hs/", "tok", "s1");
    expect(out).toEqual({ next_batch: "s2" });
    const url = String((fetchMock.mock.calls[0]! as unknown[])[0]);
    expect(url).toContain("/_matrix/client/v3/sync?");
    expect(url).toContain("since=s1");
  });

  test("throws on a non-2xx sync so the caller logs and skips", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(receiveMatrix("https://hs", "tok")).rejects.toThrow(/401/);
  });
});

describe("notifyDiscord", () => {
  test("POSTs a {content} JSON body to the webhook URL", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }));
    await notifyDiscord("https://discord.example/webhook", "hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://discord.example/webhook");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: "hello" });
  });

  test("chunks a long message into multiple POSTs at Discord's 2000-char limit", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyDiscord("https://discord.example/webhook", "x".repeat(5000));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  test("never throws when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(notifyDiscord("https://discord.example/webhook", "hi")).resolves.toBeUndefined();
  });
});

describe("sendToChannel", () => {
  test("webhook: POSTs {text} to rc.webhookUrl", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }));
    await sendToChannel(rc({ webhookUrl: "https://hook.example" }), "webhook", "hi");
    expect(calls).toEqual([{ url: "https://hook.example", body: { text: "hi" } }]);
  });

  test("slack: POSTs {text} to rc.slackWebhookUrl (reuses notifyWebhook, not a near-duplicate)", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }));
    await sendToChannel(rc({ slackWebhookUrl: "https://slack.example" }), "slack", "hi");
    expect(calls).toEqual([{ url: "https://slack.example", body: { text: "hi" } }]);
  });

  test("discord: POSTs {content} to rc.discordWebhookUrl", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }));
    await sendToChannel(rc({ discordWebhookUrl: "https://discord.example" }), "discord", "hi");
    expect(calls).toEqual([{ url: "https://discord.example", body: { content: "hi" } }]);
  });

  test("signal: POSTs to the signal-cli-rest-api /v2/send endpoint", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }));
    await sendToChannel(rc({ signalApiUrl: "http://sig", signalNumber: "+1", signalRecipients: ["+2"] }), "signal", "hi");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://sig/v2/send");
    expect(calls[0]!.body).toEqual({ message: "hi", number: "+1", recipients: ["+2"] });
  });

  test("matrix: PUTs to the room send endpoint", async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push({ url });
      return new Response("{}", { status: 200 });
    }));
    await sendToChannel(
      rc({ matrix: { homeserverUrl: "https://hs", accessToken: "tok", roomId: "!r", allowedSenders: [] } }),
      "matrix",
      "hi",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/_matrix/client/v3/rooms/");
  });

  test.each(["webhook", "slack", "discord", "signal", "matrix"] as const)(
    "%s: silently skips (no fetch) when unconfigured",
    async (channel) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await sendToChannel(rc(), channel, "hi");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("notifyTargets", () => {
  test("legacy null allowlist broadcasts to every runtime-complete channel", () => {
    const targets = notifyTargets(rc({
      webhookUrl: "https://hook", discordWebhookUrl: "https://discord",
      signalApiUrl: "http://sig", signalNumber: "+1",
      notifyAllowlist: null,
    }));
    expect(targets.sort()).toEqual(["discord", "signal", "webhook"].sort());
  });

  test("explicit allowlist narrows to the intersection with runtime-complete channels", () => {
    const targets = notifyTargets(rc({
      webhookUrl: "https://hook", discordWebhookUrl: "https://discord",
      signalApiUrl: "http://sig", signalNumber: "+1",
      notifyAllowlist: ["webhook", "slack"],
    }));
    // slack is allowlisted but not configured (no slackWebhookUrl) → excluded.
    expect(targets).toEqual(["webhook"]);
  });

  test("a channel in the allowlist but not runtime-complete is excluded", () => {
    const targets = notifyTargets(rc({
      signalApiUrl: "http://sig", // signalNumber missing → not runtime-complete
      notifyAllowlist: ["signal"],
    }));
    expect(targets).toEqual([]);
  });

  test("empty allowlist broadcasts to nothing even when channels are configured", () => {
    const targets = notifyTargets(rc({ webhookUrl: "https://hook", notifyAllowlist: [] }));
    expect(targets).toEqual([]);
  });
});
