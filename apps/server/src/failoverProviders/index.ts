import type { FailoverDestination, FailoverProvider, TargetProfile } from "@rigel/k8s/src/failover/types";
import type { FailoverValidation } from "@rigel/k8s/src/failover/validation";
import {
  DOKS_PROFILE,
  destroyDoks,
  installFailoverStack,
  provisionDoks,
  validateDigitalOcean,
  type ProvisionedCluster,
} from "./digitalocean";

/**
 * Everything a failover destination has to be able to do. A second provider is
 * one more of these plus a catalogue entry, not a change to the run.
 */
export interface FailoverProviderOps {
  validate(dest: FailoverDestination): Promise<Pick<FailoverValidation, "api" | "options">>;
  provision(dest: FailoverDestination): Promise<ProvisionedCluster>;
  destroy(dest: FailoverDestination, clusterId: string): Promise<void>;
  installStack(context: string): Promise<void>;
  profile(nodeCount: number): TargetProfile;
}

const DIGITALOCEAN: FailoverProviderOps = {
  validate: (dest) => validateDigitalOcean(dest),
  provision: (dest) => provisionDoks(dest),
  destroy: (dest, clusterId) => destroyDoks(dest, clusterId),
  installStack: (context) => installFailoverStack(context),
  profile: DOKS_PROFILE,
};

export function failoverOpsFor(provider: FailoverProvider): FailoverProviderOps {
  if (provider === "digitalocean") return DIGITALOCEAN;
  throw new Error(`No failover provider is built for ${provider}`);
}
