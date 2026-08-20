// Audio quality knobs for the agent's spoken output.
import { TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import type { RoomOutputOptions } from "@livekit/agents";

/**
 * 48 kHz end to end. Two separate 16/24 kHz ceilings were making the agent
 * sound muffled next to the same voice previewed on the web:
 * `inference.TTS` requests PCM at DEFAULT_SAMPLE_RATE = 16000, an 8 kHz audio
 * ceiling, and RoomIO's DEFAULT_ROOM_OUTPUT_OPTIONS publishes at 24000. Both
 * are set from this one constant so the chain never resamples.
 */
export const VOICE_SAMPLE_RATE = 48_000;

/** Opus ceiling, matching livekit-client's AudioPresets.music. The SDK sets no
 *  encoding at all, which leaves a speech-grade default on a track that is
 *  carrying synthesized speech, not a compressed microphone. */
export const VOICE_MAX_BITRATE = 48_000n;

export function voiceOutputOptions(): Partial<RoomOutputOptions> {
  return {
    audioSampleRate: VOICE_SAMPLE_RATE,
    audioPublishOptions: new TrackPublishOptions({
      source: TrackSource.SOURCE_MICROPHONE,
      audioEncoding: { maxBitrate: VOICE_MAX_BITRATE },
    }),
  };
}
