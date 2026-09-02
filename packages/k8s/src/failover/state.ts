import type { FailoverState } from "./types";

export function parseFailoverState(blob: string): FailoverState {
  if (!blob.trim()) return {};
  try {
    const parsed = JSON.parse(blob) as FailoverState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function serializeFailoverState(state: FailoverState): string {
  return JSON.stringify(state);
}

export function isFailoverActive(state: FailoverState): boolean {
  return !!state.failedOverTo || !!state.failoverCopyOf;
}
