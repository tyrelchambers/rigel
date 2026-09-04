import type { FailoverProvider } from "./types";

export interface FailoverProviderChoice {
  id: FailoverProvider | "aws";
  displayName: string;
  blurb: string;
  /** False renders the card disabled. Nothing else in the flow branches on it. */
  available: boolean;
  tokenDocsUrl?: string;
}

/**
 * What the first wizard step offers. One entry is real today; a second provider
 * is another entry here plus its own FailoverProviderOps on the server, not a
 * change to the chooser.
 */
export const FAILOVER_PROVIDER_CHOICES: readonly FailoverProviderChoice[] = [
  {
    id: "digitalocean",
    displayName: "DigitalOcean",
    blurb: "A DOKS cluster in the region you pick. Billed only while a failover cluster exists.",
    available: true,
    tokenDocsUrl: "https://cloud.digitalocean.com/account/api/tokens",
  },
  {
    id: "aws",
    displayName: "AWS",
    blurb: "Not built yet.",
    available: false,
  },
];

export function availableFailoverProviders(): FailoverProviderChoice[] {
  return FAILOVER_PROVIDER_CHOICES.filter((c) => c.available);
}

export function failoverProviderChoice(id: string): FailoverProviderChoice | undefined {
  return FAILOVER_PROVIDER_CHOICES.find((c) => c.id === id);
}
