/**
 * Deciding whether to grant a renderer permission request. Pulled out of
 * main.ts's Electron session handlers so the allow/deny logic, the
 * security-relevant half, is unit-testable without mocking `session`.
 *
 * Every grant requires the request's URL to be the app's own loaded origin, not
 * third-party content. Beyond that, only two permissions are ever granted:
 *  - `clipboard-sanitized-write`, so copy buttons can use
 *    `navigator.clipboard.writeText` (`clipboard-read` stays denied)
 *  - microphone (`media`) capture, and only when the voice assistant flag is on
 *    (no other feature needs a mic) and the request is audio-only (a request
 *    that also wants video is refused, not silently downgraded)
 */
export interface PermissionRequest {
  permission: string;
  requestingUrl: string | undefined;
  mediaTypes: string[] | undefined;
  voiceEnabled: boolean;
  ownOriginPrefix: string;
}

export function decidePermission(req: PermissionRequest): boolean {
  if (!isOwnOrigin(req.requestingUrl, req.ownOriginPrefix)) return false;
  if (req.permission === "clipboard-sanitized-write") return true;
  if (req.permission !== "media") return false;
  if (!req.voiceEnabled) return false;
  if (!req.mediaTypes || req.mediaTypes.length === 0) return false;
  return req.mediaTypes.every((t) => t === "audio");
}

function isOwnOrigin(requestingUrl: string | undefined, ownOriginPrefix: string): boolean {
  if (!requestingUrl) return false;
  // Compare full origins (not startsWith) so a port like :5173 can't match :51730.
  try {
    return new URL(requestingUrl).origin === new URL(ownOriginPrefix).origin;
  } catch {
    return false;
  }
}
