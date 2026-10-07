// Worker-side data frames. Deliberately NOT the renderer's livekit-client
// helper: @livekit/rtc-node differs in three ways that each fail at runtime.
//   - publishData(data, options) takes options positionally and requires it.
//   - `reliable` is a proto2 REQUIRED field, so omitting it throws while
//     serializing rather than defaulting.
//   - the destination key is `destination_identities`, not the browser's
//     `destinationIdentities`.
// DataPublishOptions is not re-exported from the package root, so the shape is
// restated here.
import type { VoiceJob } from "@rigel/server/src/voiceDispatch";

export type VoiceClient = Pick<VoiceJob, "role" | "clientIdentity">;

interface WorkerPublishOptions {
  reliable: boolean;
  topic: string;
  destination_identities: string[];
}

/**
 * The slice of rtc-node's Room the worker publishes through. `localParticipant`
 * is only assigned after a successful connect, so it is optional here too.
 */
export interface PublishRoom {
  localParticipant?: { publishData(data: Uint8Array, options: WorkerPublishOptions): Promise<void> };
  remoteParticipants: Map<string, { identity: string }>;
}

const encoder = new TextEncoder();

/**
 * Targeted at the room's client rather than broadcast: anyone else who got a
 * token for the room would otherwise receive the action frames.
 */
export async function publishJson(
  room: PublishRoom,
  client: VoiceClient,
  topic: string,
  payload: unknown,
): Promise<void> {
  const local = room.localParticipant;
  if (!local) return;
  try {
    await local.publishData(encoder.encode(JSON.stringify(payload)), {
      reliable: true,
      topic,
      destination_identities: [client.clientIdentity],
    });
  } catch (err) {
    console.error(`publishing ${topic} failed:`, err);
  }
}

export function desktopPresent(room: PublishRoom, client: VoiceClient): boolean {
  if (client.role !== "desktop") return false;
  for (const p of room.remoteParticipants.values()) {
    if (p.identity === client.clientIdentity) return true;
  }
  return false;
}
