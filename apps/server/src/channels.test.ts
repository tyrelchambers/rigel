import { afterEach, test, expect, vi } from "vitest";
import { handleChannelTest } from "./channels";

afterEach(() => vi.unstubAllGlobals());

test("handleChannelTest posts {content} to the url for discord", async () => {
  const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await handleChannelTest({ action: "sendTest", channel: "discord", url: "https://discord.com/api/webhooks/x" });
  expect(result).toEqual({ kind: "json", body: { ok: true } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://discord.com/api/webhooks/x");
  expect(init.method).toBe("POST");
  expect(init.headers).toMatchObject({ "content-type": "application/json" });
  expect(JSON.parse(init.body as string)).toEqual({ content: expect.stringContaining("Discord") });
});

test("handleChannelTest posts {text} to the url for slack", async () => {
  const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await handleChannelTest({ action: "sendTest", channel: "slack", url: "https://hooks.slack.com/services/x" });
  expect(result).toEqual({ kind: "json", body: { ok: true } });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://hooks.slack.com/services/x");
  expect(JSON.parse(init.body as string)).toEqual({ text: expect.stringContaining("Slack") });
});

test("handleChannelTest returns 422 when the url is empty", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const result = await handleChannelTest({ action: "sendTest", channel: "discord", url: "  " });
  expect(result).toEqual({ kind: "error", status: 422, message: "Paste the webhook URL first." });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("handleChannelTest maps a non-2xx response to a 502 error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
  const result = await handleChannelTest({ action: "sendTest", channel: "discord", url: "https://discord.com/api/webhooks/x" });
  expect(result).toEqual({ kind: "error", status: 502, message: "Send test failed: HTTP 500" });
});

test("handleChannelTest maps a fetch throw to a 502 error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
  const result = await handleChannelTest({ action: "sendTest", channel: "slack", url: "https://hooks.slack.com/services/x" });
  expect(result).toEqual({ kind: "error", status: 502, message: "Send test failed: network down" });
});

test("handleChannelTest rejects an unexpected action", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const result = await handleChannelTest({ action: "explode", channel: "discord", url: "https://x" } as never);
  expect(result).toEqual({ kind: "error", status: 422, message: "unknown action: explode" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("handleChannelTest rejects an unsupported channel", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const result = await handleChannelTest({ action: "sendTest", channel: "signal", url: "https://example.com" });
  expect(result).toEqual({ kind: "error", status: 422, message: "unsupported channel: signal" });
  expect(fetchMock).not.toHaveBeenCalled();
});
