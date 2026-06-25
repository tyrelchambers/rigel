import type { ProviderDescriptor } from "./types";

export const digitalocean: ProviderDescriptor = {
  id: "digitalocean",
  displayName: "DigitalOcean",
  binary: "doctl",
  extraBinaries: [],
  installHelp: {
    macos: "brew install doctl",
    linux: "snap install doctl",
    windows: "scoop install doctl   # or: choco install doctl",
    docsUrl: "https://docs.digitalocean.com/reference/doctl/how-to/install/",
  },
  versionArgs: ["version"],
  authCheckArgs: ["account", "get", "-o", "json"],
  loginHelp: {
    command: "doctl auth init",
    explanation:
      "Paste a DigitalOcean Personal Access Token (with the kubernetes:read scope) when prompted.",
    docsUrl: "https://docs.digitalocean.com/reference/api/create-personal-access-token/",
  },
  reloginHelp: {
    command: "doctl auth init",
    explanation:
      "Your DigitalOcean token expired or was revoked. Re-run this and paste a fresh token.",
  },
  requiredParams: [],
  listClustersArgs: () => ["kubernetes", "cluster", "list", "-o", "json"],
  parseClusterList: (stdout) => {
    const arr = JSON.parse(stdout) as { id: string; name: string; region: string }[];
    return arr.map((c) => ({ id: c.id, name: c.name, region: c.region }));
  },
  parseAccount: (stdout) => {
    const data = JSON.parse(stdout);
    // Defensive guard: doctl `account get -o json` returns an object, but future
    // providers' account calls may return an array (take the first element).
    const acct = Array.isArray(data) ? data[0] : data;
    return typeof acct?.email === "string" ? acct.email : null;
  },
  connectArgs: (cluster) => ["kubernetes", "cluster", "kubeconfig", "save", cluster.id],
  authErrorPatterns: ["401", "unable to authenticate"],
  consoleUrl: "https://cloud.digitalocean.com/kubernetes/clusters",
};

/** All providers Rigel can connect to today (DigitalOcean first). */
export const DESCRIPTORS: Record<string, ProviderDescriptor> = {
  digitalocean,
};

export function descriptorFor(provider: string): ProviderDescriptor | undefined {
  return DESCRIPTORS[provider];
}

export function listCloudProviders(): ProviderDescriptor[] {
  return Object.values(DESCRIPTORS);
}
