// Voice room tokens. The LiveKit API secret never reaches the renderer: it
// only receives short-lived JWTs. The worker is a local process forked by
// Electron at the same trust level as the server, and its one route for
// this, /api/voice/agent-config, is gated by both the global session secret
// and the worker token, so it can receive the secret directly (it needs to
// sign its own requests to LiveKit's inference gateway).
import { randomBytes } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { envVoiceFields, voiceConfig, voiceStatus, VOICE_FIELDS, type VoiceConfig, type VoiceStatus } from "./voiceConfig";
import { checkSessionSecret } from "./sessionAuth";

export const VOICE_ROOM = "rigel-voice";

export type VoiceRole = "desktop" | "agent" | "phone";

export function identityFor(role: VoiceRole): string {
  if (role === "desktop") return "rigel-desktop";
  if (role === "agent") return "rigel-agent";
  return `rigel-phone-${randomBytes(4).toString("hex")}`;
}

/**
 * The `kind` claim, not the `agent` video grant, is what makes LiveKit report a
 * participant as `ParticipantKind.AGENT`. The grant only says "allowed to
 * register as an Agent Framework worker", which is a different permission and
 * one this worker never uses, since it joins the room directly instead of being
 * dispatched. `@livekit/agents` mints its own agent-participant tokens the same
 * way (see `workflows/warm_transfer.js`: `token.kind = "agent"`).
 *
 * `canUpdateOwnMetadata` is the other half: `@livekit/agents` reports its state
 * through `localParticipant.setAttributes({ "lk.agent.state": ... })`, and
 * rtc-node never surfaces the server's rejection when the grant is missing, so
 * the write just does not land.
 *
 * Both feed `useVoiceAssistant`, whose only failure mode is a permanent
 * "connecting". The renderer no longer depends on that hook for state (the
 * worker publishes its own on `rigel.agent.state`), but the hook still supplies
 * the agent's audio track for the waveform.
 */
export async function mintVoiceToken(role: VoiceRole): Promise<{ url: string; token: string } | null> {
  const c = await voiceConfig();
  if (!c.url || !c.apiKey || !c.apiSecret) return null;
  const at = new AccessToken(c.apiKey, c.apiSecret, { identity: identityFor(role), ttl: "6h" });
  if (role === "agent") at.kind = "agent";
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

/**
 * What the Settings panel is allowed to see. The renderer holds only the
 * session secret, so a stored secret never crosses this boundary: apiSecret and
 * openrouterApiKey are reported as set/unset booleans.
 */
export interface MaskedVoiceConfig {
  url: string;
  apiKey: string;
  model: string;
  sttModel: string;
  ttsModel: string;
  apiSecretSet: boolean;
  openrouterApiKeySet: boolean;
  /** Field to the env var supplying it; those fields are not editable here. */
  env: Partial<Record<keyof VoiceConfig, string>>;
  status: VoiceStatus;
}

export async function maskedVoiceConfig(): Promise<MaskedVoiceConfig> {
  const c = await voiceConfig();
  return {
    url: c.url,
    apiKey: c.apiKey,
    model: c.model,
    sttModel: c.sttModel,
    ttsModel: c.ttsModel,
    apiSecretSet: !!c.apiSecret,
    openrouterApiKeySet: !!c.openrouterApiKey,
    env: envVoiceFields(),
    status: await voiceStatus(),
  };
}

/**
 * The writable fields of a PUT body. An absent key means "leave alone" and an
 * empty string means "clear", the distinction setVoiceConfig already draws, so
 * unknown keys and non-strings are dropped rather than coerced to "".
 */
export function voiceConfigPatch(body: unknown): Partial<VoiceConfig> {
  const patch: Partial<VoiceConfig> = {};
  if (!body || typeof body !== "object") return patch;
  const rec = body as Record<string, unknown>;
  for (const k of VOICE_FIELDS) {
    const v = rec[k];
    if (typeof v === "string") patch[k] = v;
  }
  return patch;
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
