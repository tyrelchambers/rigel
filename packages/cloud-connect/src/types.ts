export type CloudProvider = "digitalocean" | "aws" | "gcp" | "azure";

/** A cluster as listed from a provider, normalized across providers. */
export interface CloudCluster {
  id: string;
  name: string;
  region: string;
}

export interface InstallHelp {
  macos: string;
  linux: string;
  windows: string;
  docsUrl: string;
}

export interface CommandHelp {
  command: string;
  explanation: string;
  docsUrl?: string;
}

/**
 * Everything Rigel needs to connect to one cloud provider by driving its CLI.
 * Node-free: command builders return argv arrays; the server spawns them.
 */
export interface ProviderDescriptor {
  id: CloudProvider;
  displayName: string;
  /** The CLI binary, e.g. "doctl". */
  binary: string;
  /** Extra binaries kubectl needs at runtime (gcp: gke-gcloud-auth-plugin). */
  extraBinaries: string[];
  installHelp: InstallHelp;
  /** Args that exit 0 iff the binary is present (e.g. ["version"]). */
  versionArgs: string[];
  /** Read-only args that exit 0 iff the user is logged in. */
  authCheckArgs: string[];
  loginHelp: CommandHelp;
  reloginHelp: CommandHelp;
  /** Param keys the user must supply before listing (DigitalOcean: none). */
  requiredParams: string[];
  listClustersArgs: (params: Record<string, string>) => string[];
  parseClusterList: (stdout: string) => CloudCluster[];
  /** Parse the account identity (e.g. email) from the auth-check stdout, for display. */
  parseAccount?: (stdout: string) => string | null;
  connectArgs: (cluster: CloudCluster, params: Record<string, string>) => string[];
  /** Lowercased-substring matches on kubectl/CLI stderr meaning "re-login". */
  authErrorPatterns: string[];
  /** URL to the provider's console page for creating/viewing clusters. */
  consoleUrl?: string;
}
