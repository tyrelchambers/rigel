// Helm release reading + argv construction, shared by the server (execution)
// and the web app (live release derivation + command preview).
import { gunzipSync, strFromU8 } from "fflate";

export interface HelmReleasePayload {
  name: string;
  namespace: string;
  version: number;
  info: {
    status: string;
    first_deployed?: string;
    last_deployed?: string;
    description?: string;
    notes?: string;
  };
  chart: { metadata: { name: string; version: string; appVersion?: string }; values?: unknown };
  config?: unknown;
  manifest?: string;
}

/**
 * Decode a Helm v3 release Secret's `data.release` value. Helm stores the
 * release as base64(gzip(JSON)); Kubernetes then base64-encodes the Secret
 * value again, so the input is double-base64'd. The gzip magic is checked so a
 * (rare) ungzipped payload still decodes. Returns null on any malformed input.
 */
export function decodeReleaseSecret(release: string): HelmReleasePayload | null {
  try {
    const helmB64 = atob(release);               // -> base64(gzip(json))
    const binary = atob(helmB64);                // -> gzip(json) as a binary string
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const json = gzipped ? strFromU8(gunzipSync(bytes)) : binary;
    return JSON.parse(json) as HelmReleasePayload;
  } catch {
    return null;
  }
}
