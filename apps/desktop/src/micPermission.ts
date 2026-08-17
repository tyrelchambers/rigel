/**
 * Deciding whether to grant the renderer's `getUserMedia` audio request. Pulled
 * out of main.ts's Electron session handlers so the allow/deny logic, the
 * security-relevant half, is unit-testable without mocking `session`.
 *
 * Grants ONLY microphone (`audio`) capture, and only when all three hold:
 *  - the voice assistant flag is on (no other feature needs a mic)
 *  - the request is audio-only (a request that also wants video is refused,
 *    not silently downgraded)
 *  - the request's URL is the app's own loaded origin, not third-party content
 */
export interface MicPermissionRequest {
  permission: string;
  requestingUrl: string | undefined;
  mediaTypes: string[] | undefined;
  voiceEnabled: boolean;
  ownOriginPrefix: string;
}

export function decideMicPermission(req: MicPermissionRequest): boolean {
  if (req.permission !== "media") return false;
  if (!req.voiceEnabled) return false;
  if (!req.mediaTypes || req.mediaTypes.length === 0) return false;
  if (!req.mediaTypes.every((t) => t === "audio")) return false;
  if (!req.requestingUrl) return false;
  // Compare full origins (not startsWith) so a port like :5173 can't match :51730.
  try {
    return new URL(req.requestingUrl).origin === new URL(req.ownOriginPrefix).origin;
  } catch {
    return false;
  }
}
