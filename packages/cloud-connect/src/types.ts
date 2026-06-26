export type CloudProvider = "digitalocean" | "aws" | "gcp" | "azure";

/** A cluster as listed from a provider, normalized across providers. */
export interface CloudCluster {
  id: string;
  name: string;
  region: string;
  /** GKE: the cluster's location/region, needed by connect. */
  location?: string;
  /** AKS: the cluster's resource group, needed by connect. */
  resourceGroup?: string;
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

/** A required connect param (e.g. AWS region, GCP project) rendered as a dropdown. */
export interface ParamSpec {
  key: string;                 // "region" | "project"
  label: string;               // "Region" | "Project"
  /** Built-in option list (AWS regions). */
  staticOptions?: string[];
  /** CLI args that print options, one per line (GCP: gcloud projects list). */
  optionsArgs?: string[];
  /** CLI args that print the configured default value (one line). */
  defaultArgs?: string[];
}

/** Install help for an extra runtime binary (GKE auth plugin, AKS kubelogin). */
export interface ExtraInstallHelp {
  binary: string;              // "gke-gcloud-auth-plugin" | "kubelogin"
  command: string;             // the install command (same on all OSes)
  docsUrl: string;
}

/** Maps a recognizable CLI error to friendly, actionable guidance. */
export interface ErrorHint {
  /** Lowercased substrings; the hint matches if ANY is present in the stderr. */
  match: string[];
  title: string;
  steps: string[];
  docsUrl?: string;
  docsLabel?: string;
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
  /** Params the user picks before listing (DigitalOcean/Azure: []). */
  requiredParams: ParamSpec[];
  /** Install help for the extra binary, shown in the needs-extra panel. */
  extraInstallHelp?: ExtraInstallHelp;
  /** Recognized-error guidance shown in the wizard's error panel. */
  errorHints?: ErrorHint[];
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
