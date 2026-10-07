import { describe, expect, test, vi } from "vitest";
import type { VoiceJob } from "@rigel/server/src/voiceDispatch";
import { createSseParser, listenForJobs } from "./dispatch.js";

const job = (room: string): VoiceJob => ({
  room,
  role: "desktop",
  clientIdentity: "rigel-desktop",
  context: null,
  config: {
    url: "wss://x",
    token: "t",
    model: "m",
    sttModel: "s",
    ttsModel: "t",
    apiKey: "k",
    apiSecret: "secret",
    openrouterApiKey: "or",
  },
});

describe("createSseParser", () => {
  test("reads one event", () => {
    const parse = createSseParser();
    expect(parse('event: job\ndata: {"a":1}\n\n')).toEqual([{ event: "job", data: '{"a":1}' }]);
  });

  test("holds an event split mid-way until it completes", () => {
    const parse = createSseParser();
    expect(parse("event: jo")).toEqual([]);
    expect(parse('b\ndata: {"a"')).toEqual([]);
    expect(parse(":1}\n")).toEqual([]);
    expect(parse("\n")).toEqual([{ event: "job", data: '{"a":1}' }]);
  });

  test("ignores heartbeat comments", () => {
    const parse = createSseParser();
    expect(parse(": ping\n\n")).toEqual([]);
    expect(parse(": ping\n\nevent: job\ndata: 1\n\n: ping\n\n")).toEqual([{ event: "job", data: "1" }]);
  });

  test("returns every event in a chunk, in order", () => {
    const parse = createSseParser();
    expect(parse("event: job\ndata: 1\n\nevent: job\ndata: 2\n\nevent: job\ndata: 3")).toEqual([
      { event: "job", data: "1" },
      { event: "job", data: "2" },
    ]);
    expect(parse("\n\n")).toEqual([{ event: "job", data: "3" }]);
  });

  test("an event without a name is a message, and data lines join with newlines", () => {
    const parse = createSseParser();
    expect(parse("data: a\ndata: b\n\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });
});

async function* streamOf(jobs: VoiceJob[]): AsyncIterable<VoiceJob> {
  yield* jobs;
}

class Stop extends Error {}

describe("listenForJobs", () => {
  test("hands every job to the callback", async () => {
    const seen: string[] = [];
    const jobs = vi.fn(async () => streamOf([job("a"), job("b")]));
    const wait = vi.fn(async () => {
      throw new Stop();
    });
    await expect(listenForJobs({ jobs }, (j) => seen.push(j.room), wait)).rejects.toBeInstanceOf(Stop);
    expect(seen).toEqual(["a", "b"]);
  });

  test("reconnects forever, backing off from 1s doubling to 10s, reset by a successful connect", async () => {
    const outcomes = [false, false, false, false, false, true, false, false];
    const jobs = vi.fn(async () => {
      if (!outcomes.shift()) throw new Error("ECONNREFUSED");
      return streamOf([]);
    });
    const delays: number[] = [];
    const wait = vi.fn(async (ms: number) => {
      delays.push(ms);
      if (outcomes.length === 0) throw new Stop();
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(listenForJobs({ jobs }, () => {}, wait)).rejects.toBeInstanceOf(Stop);
    error.mockRestore();
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000, 1000, 2000, 4000]);
  });

  test("a stream that fails mid-way is reconnected too", async () => {
    const jobs = vi.fn(async () =>
      (async function* () {
        yield job("a");
        throw new Error("socket hang up");
      })(),
    );
    let waits = 0;
    const wait = vi.fn(async () => {
      if (++waits === 2) throw new Stop();
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(listenForJobs({ jobs }, () => {}, wait)).rejects.toBeInstanceOf(Stop);
    error.mockRestore();
    expect(jobs).toHaveBeenCalledTimes(2);
  });
  test("a failure that repeats is logged once per streak, and again after a connect", async () => {
    const outcomes: (string | null)[] = [
      "dispatch failed: 404",
      "dispatch failed: 404",
      "dispatch failed: 404",
      "ECONNREFUSED",
      "ECONNREFUSED",
      null,
      "dispatch failed: 404",
    ];
    const jobs = vi.fn(async () => {
      const failure = outcomes.shift();
      if (failure) throw new Error(failure);
      return streamOf([]);
    });
    const wait = vi.fn(async () => {
      if (outcomes.length === 0) throw new Stop();
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(listenForJobs({ jobs }, () => {}, wait)).rejects.toBeInstanceOf(Stop);
    const logged = error.mock.calls.map((c) => String(c[0]));
    error.mockRestore();
    expect(logged).toEqual([
      "dispatch stream failed: dispatch failed: 404",
      "dispatch stream failed: ECONNREFUSED",
      "dispatch stream failed: dispatch failed: 404",
    ]);
  });
});
