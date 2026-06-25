import type { CloudProvider } from "@rigel/cloud-connect/src/index";

export type ConnectTarget = CloudProvider | "import";

export interface Entitlement {
  allowed: boolean;
  reason?: string;
}

/**
 * Monetization seam (Stream 3 / HELM-16 will consult the user's plan here, e.g.
 * keep `import` free and gate the cloud providers). v1 allows everything.
 */
export function canConnect(_target: ConnectTarget): Entitlement {
  return { allowed: true };
}
