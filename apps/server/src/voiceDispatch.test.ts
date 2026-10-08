import { afterEach, describe, expect, test, vi } from "vitest";
import { createVoiceDispatch, voiceDispatchStream, type VoiceJob } from "./voiceDispatch";

const job = (room = "rigel-desktop-0a1b2c3d"): VoiceJob => ({
  room,
  role: "desktop",
  clientIdentity: "rigel-desktop",
  context: "kind-rigel",
  config: {
    url: "wss://test.livekit.example",
    token: "agent-jwt",
    model: "m",
    sttModel: "s",
    ttsModel: "t",
    apiKey: "k",
    apiSecret: "secret",
    openrouterApiKey: "or",
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createVoiceDispatch", () => {
  test("no worker attached means the job is not delivered", () => {
    expect(createVoiceDispatch().dispatch(job())).toBe(false);
  });

  test("delivers to the attached worker", () => {
    const hub = createVoiceDispatch();
    const got: VoiceJob[] = [];
    hub.subscribe((j) => got.push(j));
    expect(hub.dispatch(job())).toBe(true);
    expect(got).toEqual([job()]);
  });

  test("the newest subscriber replaces an older one", () => {
    const hub = createVoiceDispatch();
    const older = vi.fn();
    const newer = vi.fn();
    hub.subscribe(older);
    hub.subscribe(newer);
    hub.dispatch(job());
    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledTimes(1);
  });

  test("a replaced subscriber detaching leaves the newer one attached", () => {
    const hub = createVoiceDispatch();
    const detachOlder = hub.subscribe(vi.fn());
    const newer = vi.fn();
    hub.subscribe(newer);
    detachOlder();
    expect(hub.dispatch(job())).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
  });

  test("a detached subscriber gets nothing", () => {
    const hub = createVoiceDispatch();
    const listener = vi.fn();
    hub.subscribe(listener)();
    expect(hub.dispatch(job())).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  test("a subscriber that throws is detached and the job reported undelivered", () => {
    const hub = createVoiceDispatch();
    hub.subscribe(() => {
      throw new Error("stream closed");
    });
    expect(hub.dispatch(job())).toBe(false);
    expect(hub.dispatch(job())).toBe(false);
  });
});

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

describe("voiceDispatchStream", () => {
  test("delivers each job as a job event with JSON data", async () => {
    const hub = createVoiceDispatch();
    const reader = voiceDispatchStream(hub).getReader();
    expect(hub.dispatch(job())).toBe(true);
    expect(await readChunk(reader)).toBe(`event: job\ndata: ${JSON.stringify(job())}\n\n`);
    await reader.cancel();
  });

  test("sends a comment heartbeat on the interval", async () => {
    vi.useFakeTimers();
    const hub = createVoiceDispatch();
    const reader = voiceDispatchStream(hub, 15_000).getReader();
    vi.advanceTimersByTime(15_000);
    expect(await readChunk(reader)).toBe(": ping\n\n");
    await reader.cancel();
  });

  test("cancelling the stream detaches the worker", async () => {
    const hub = createVoiceDispatch();
    const reader = voiceDispatchStream(hub).getReader();
    await reader.cancel();
    expect(hub.dispatch(job())).toBe(false);
  });

  test("a stream replaced by a newer one stops receiving jobs", async () => {
    const hub = createVoiceDispatch();
    const older = voiceDispatchStream(hub).getReader();
    const newer = voiceDispatchStream(hub).getReader();
    hub.dispatch(job("rigel-desktop-11111111"));
    expect(await readChunk(newer)).toContain("rigel-desktop-11111111");
    await older.cancel();
    expect(hub.dispatch(job("rigel-desktop-22222222"))).toBe(true);
    expect(await readChunk(newer)).toContain("rigel-desktop-22222222");
    await newer.cancel();
  });
});
