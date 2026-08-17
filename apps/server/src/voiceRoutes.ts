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
  });
  return { url: c.url, token: await at.toJwt() };
}

export interface AgentConfigResponse {
  url: string;
  token: string;
  model: string;
  apiKey: string;
  apiSecret: string;
  openrouterApiKey: string;
  deepgramApiKey: string;
  cartesiaApiKey: string;
}

export async function agentConfigResponse(): Promise<AgentConfigResponse | null> {
  const c = await voiceConfig();
  const minted = await mintVoiceToken("agent");
  if (!minted || !c.openrouterApiKey) return null;
  return {
    ...minted,
    model: c.model,
    apiKey: c.apiKey,
    apiSecret: c.apiSecret,
    openrouterApiKey: c.openrouterApiKey,
    deepgramApiKey: c.deepgramApiKey,
    cartesiaApiKey: c.cartesiaApiKey,
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
