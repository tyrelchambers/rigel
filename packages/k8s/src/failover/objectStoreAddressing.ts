import type { ObjectStoreAddressing } from "./types";

const VIRTUAL_HOST_SUFFIXES = ["amazonaws.com", "digitaloceanspaces.com"];

/**
 * What to pre-fill the addressing toggle with. Only a suggestion: the value
 * that gets stored is whatever the toggle shows when the user validates, so a
 * store behind wildcard DNS or a custom domain is never silently guessed wrong.
 */
export function suggestAddressing(endpoint: string): ObjectStoreAddressing {
  let host: string;
  try {
    host = new URL(endpoint.trim()).hostname.toLowerCase();
  } catch {
    return "path";
  }
  return VIRTUAL_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`)) ? "virtualHost" : "path";
}
