import { TrackSource } from "@livekit/rtc-node";
import { expect, test } from "vitest";
import { VOICE_MAX_BITRATE, VOICE_SAMPLE_RATE, voiceOutputOptions } from "./audio.js";

test("the agent publishes at 48 kHz, not the SDK's 24 kHz default", () => {
  expect(VOICE_SAMPLE_RATE).toBe(48_000);
  expect(voiceOutputOptions().audioSampleRate).toBe(48_000);
});

test("the published track carries an explicit Opus ceiling", () => {
  const opts = voiceOutputOptions().audioPublishOptions;
  expect(opts?.source).toBe(TrackSource.SOURCE_MICROPHONE);
  expect(opts?.audioEncoding?.maxBitrate).toBe(VOICE_MAX_BITRATE);
});
