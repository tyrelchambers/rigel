/**
 * Deciding whether to grant a renderer permission request. Pulled out of
 * main.ts's Electron session handlers so the allow/deny logic, the
 * security-relevant half, is unit-testable without mocking `session`.
 *
 * Every grant requires the request's URL to be the app's own loaded origin, not
 * third-party content. Beyond that, only `clipboard-sanitized-write` is ever
 * granted, so copy buttons can use `navigator.clipboard.writeText`
 * (`clipboard-read` stays denied).
 */
export interface PermissionRequest {
  permission: string;
  requestingUrl: string | undefined;
  ownOriginPrefix: string;
}

export function decidePermission(req: PermissionRequest): boolean {
  if (!isOwnOrigin(req.requestingUrl, req.ownOriginPrefix)) return false;
  return req.permission === "clipboard-sanitized-write";
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
