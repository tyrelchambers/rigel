// Voice room tokens. The LiveKit API secret never reaches the renderer: it
// only receives short-lived JWTs. The worker is a local process forked by
// Electron at the same trust level as the server, and its one route for
// this, /api/voice/agent-config, is gated by both the global session secret
// and the worker token, so it can receive the secret directly (it needs to
// sign its own requests to LiveKit's inference gateway).
import { randomBytes } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { voiceConfig } from "./voiceConfig";
import { checkSessionSecret } from "./sessionAuth";

export const VOICE_ROOM = "rigel-voice";

export type VoiceRole = "desktop" | "agent" | "phone";

export function identityFor(role: VoiceRole): string {
  if (role === "desktop") return "rigel-desktop";
  if (role === "agent") return "rigel-agent";
  return `rigel-phone-${randomBytes(4).toString("hex")}`;
}

/**
 * `agent: true` and `canUpdateOwnMetadata: true` are load-bearing beyond
 * what their names suggest. `@livekit/components-react`'s `useVoiceAssistant`
 * finds the agent solely via `participant.kind === ParticipantKind.AGENT`
 * (set server-side from the `agent` grant on the room-join token) and reads
 * its state solely from the `lk.agent.state` attribute, which `@livekit/agents`
 * writes with `localParticipant.setAttributes(...)`, a call that requires
 * `canUpdateOwnMetadata` and silently rejects without it. Omit either grant
 * and the renderer can never see the agent: it stays on "Connecting..."
 * forever with no error, because nothing in this file's types says so.
 */
export async function mintVoiceToken(role: VoiceRole): Promise<{ url: string; token: string } | null> {
  const c = await voiceConfig();
  if (!c.url || !c.apiKey || !c.apiSecret) return null;
  const at = new AccessToken(c.apiKey, c.apiSecret, { identity: identityFor(role), ttl: "6h" });
  // phone excluded: the desktop and the worker trust data-channel frames
  // (rigel.state / rigel.context) to carry the active kubectl context. A
  // phone with canPublishData could forge those and redirect the worker to
  // a different cluster.
  at.addGrant({
    roomJoin: true,
    room: VOICE_ROOM,
    canPublish: true,
    canSubscribe: true,
    canPublishData: role !== "phone",
    canUpdateOwnMetadata: role !== "phone",
    agent: role === "agent",
  });
  return { url: c.url, token: await at.toJwt() };
}

export interface AgentConfigResponse {
  url: string;
  token: string;
  model: string;
  sttModel: string;
  ttsModel: string;
  apiKey: string;
  apiSecret: string;
  openrouterApiKey: string;
}

export async function agentConfigResponse(): Promise<AgentConfigResponse | null> {
  const c = await voiceConfig();
  const minted = await mintVoiceToken("agent");
  if (!minted || !c.openrouterApiKey) return null;
  return {
    ...minted,
    model: c.model,
    sttModel: c.sttModel,
    ttsModel: c.ttsModel,
    apiKey: c.apiKey,
    apiSecret: c.apiSecret,
    openrouterApiKey: c.openrouterApiKey,
  };
}

/** Gate for /api/voice/agent-config. This is layered ON TOP of the global
 * `/api/*` session-secret gate in index.ts, not a substitute for it — the
 * session secret alone is not enough here because the renderer also holds
 * it, and this route returns provider keys the renderer must never see. An
 * UNSET expected token denies (there is no allow-all dev mode for this
 * route). */
export function checkWorkerToken(provided: string | null | undefined): boolean {
  const expected = process.env.RIGEL_VOICE_WORKER_TOKEN?.trim() ?? "";
  if (!expected) return false;
  return checkSessionSecret(provided, expected);
}

/** The header the voice worker signs every request to this server with. */
export const VOICE_WORKER_HEADER = "x-rigel-voice-worker";

/**
 * Whether a request came from the voice worker rather than the renderer. Used
 * to tag which AI surface performed an action; both post the same routes, so
 * the signed worker header is the only thing that tells them apart. Falls to
 * false for the renderer, which never holds the worker token.
 */
export function isVoiceWorkerRequest(req: { headers: { get(name: string): string | null } }): boolean {
  return checkWorkerToken(req.headers.get(VOICE_WORKER_HEADER));
}
