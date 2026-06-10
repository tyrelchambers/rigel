// Client-side purge model. Mirrors the Swift `PurgePlan` struct and
// docs/parity/purge.md "State & Data Flow".

import type { PurgeResourceKind } from "@/lib/api";

/** One row in the purge confirm sheet's resource list. */
export interface PlanResource {
  kind: PurgeResourceKind;
  name: string;
  namespace: string;
  /** User toggle state (PVCs default off, all others default on). */
  selected: boolean;
}

/** The full purge plan populated from a dry-run discovery. */
export interface PurgePlan {
  appName: string; // root deployment name
  namespace: string;
  resources: PlanResource[];
  helmRelease?: string; // undefined when not helm-managed
  databaseHint?: string; // undefined when no discoverable DB
  dropDatabase: boolean; // user toggle, default false
  blockedReason?: string; // non-empty blocks the entire flow
}

/** PVCs default to UNselected (data opt-in); everything else defaults on. */
export function defaultSelectedForKind(kind: PurgeResourceKind): boolean {
  return kind !== "persistentvolumeclaim";
}
