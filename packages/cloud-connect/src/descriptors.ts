import type { ErrorHint, ProviderDescriptor } from "./types";

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

/** Standard AWS commercial regions (stable; avoids needing ec2:DescribeRegions). */
export const AWS_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "af-south-1", "ap-east-1", "ap-south-1", "ap-south-2",
  "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4",
  "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ca-central-1", "ca-west-1",
  "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3",
  "eu-south-1", "eu-south-2", "eu-north-1",
  "me-south-1", "me-central-1", "il-central-1", "sa-east-1",
];

export const aws: ProviderDescriptor = {
  id: "aws",
  displayName: "Amazon EKS",
  binary: "aws",
  extraBinaries: [],
  installHelp: {
    macos: "brew install awscli",
    linux: "curl 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip' -o awscliv2.zip && unzip awscliv2.zip && sudo ./aws/install",
    windows: "msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi",
    docsUrl: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
  },
  versionArgs: ["--version"],
  authCheckArgs: ["sts", "get-caller-identity", "--output", "json"],
  loginHelp: {
    command: "aws configure",
    explanation: "Set up AWS credentials (access key + secret), or run `aws configure sso` for SSO. The IAM principal must also be granted access on the cluster (an EKS access entry) or kubectl will be RBAC-denied.",
    docsUrl: "https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html",
  },
  reloginHelp: {
    command: "aws sso login",
    explanation: "Your AWS session expired. Re-run your SSO login (or `aws configure`).",
  },
  requiredParams: [{
    key: "region", label: "Region",
    staticOptions: AWS_REGIONS,
    defaultArgs: ["configure", "get", "region"],
  }],
  listClustersArgs: (p) => ["eks", "list-clusters", "--region", p.region, "--output", "json"],
  parseClusterList: (stdout) => {
    const data = JSON.parse(stdout) as { clusters?: string[] };
    return (data.clusters ?? []).map((name) => ({ id: name, name, region: "" }));
  },
  parseAccount: (stdout) => {
    const d = JSON.parse(stdout);
    if (typeof d?.Arn === "string") return d.Arn;
    return typeof d?.Account === "string" ? d.Account : null;
  },
  connectArgs: (cluster, p) => ["eks", "update-kubeconfig", "--region", p.region, "--name", cluster.name],
  authErrorPatterns: ["expiredtoken", "unable to locate credentials", "invalidclienttoken", "the security token included in the request is expired"],
  consoleUrl: "https://console.aws.amazon.com/eks/home",
  errorHints: [
    {
      match: ["not authorized to perform", "accessdenied", "access denied", "is not authorized"],
      title: "Your AWS identity can't access EKS",
      steps: [
        "Attach an IAM policy that allows eks:ListClusters and eks:DescribeCluster (for example the managed AmazonEKSClusterPolicy).",
        "To use a cluster, add an EKS access entry mapping your IAM principal to a Kubernetes group.",
      ],
      docsUrl: "https://docs.aws.amazon.com/eks/latest/userguide/security-iam.html",
      docsLabel: "EKS permissions docs",
    },
    {
      match: ["expiredtoken", "the security token included in the request is expired", "token has expired"],
      title: "Your AWS session expired",
      steps: [
        "Re-authenticate with the AWS CLI: run aws sso login, or aws configure for static keys.",
        "Then try again.",
      ],
      docsUrl: "https://docs.aws.amazon.com/cli/latest/userguide/cli-authentication-user.html",
      docsLabel: "AWS CLI auth docs",
    },
  ],
};

export const gcp: ProviderDescriptor = {
  id: "gcp",
  displayName: "Google GKE",
  binary: "gcloud",
  extraBinaries: ["gke-gcloud-auth-plugin"],
  installHelp: {
    macos: "brew install --cask google-cloud-sdk",
    linux: "curl https://sdk.cloud.google.com | bash",
    windows: "(New-Object Net.WebClient).DownloadFile('https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe', \"$env:Temp\\gcloud.exe\"); & \"$env:Temp\\gcloud.exe\"",
    docsUrl: "https://cloud.google.com/sdk/docs/install",
  },
  extraInstallHelp: {
    binary: "gke-gcloud-auth-plugin",
    command: "gcloud components install gke-gcloud-auth-plugin",
    docsUrl: "https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl#install_plugin",
  },
  versionArgs: ["--version"],
  authCheckArgs: ["config", "get-value", "account"],
  loginHelp: {
    command: "gcloud auth login",
    explanation: "Sign in to Google Cloud in your browser.",
    docsUrl: "https://cloud.google.com/sdk/gcloud/reference/auth/login",
  },
  reloginHelp: {
    command: "gcloud auth login",
    explanation: "Your Google Cloud session expired. Re-run to sign in again.",
  },
  requiredParams: [{
    key: "project", label: "Project",
    optionsArgs: ["projects", "list", "--format=value(projectId)"],
    defaultArgs: ["config", "get-value", "project"],
  }],
  listClustersArgs: (p) => ["container", "clusters", "list", "--project", p.project, "--format=json"],
  parseClusterList: (stdout) => {
    const arr = JSON.parse(stdout) as { name: string; location: string }[];
    return arr.map((c) => ({ id: c.name, name: c.name, region: c.location, location: c.location }));
  },
  parseAccount: (stdout) => {
    const s = stdout.trim();
    return s && s !== "(unset)" ? s : null;
  },
  connectArgs: (cluster, p) => ["container", "clusters", "get-credentials", cluster.name, "--location", cluster.location ?? "", "--project", p.project],
  authErrorPatterns: ["invalid_grant", "reauthentication", "token has been expired or revoked"],
  consoleUrl: "https://console.cloud.google.com/kubernetes/list",
  errorHints: [
    {
      match: ["api has not been used", "is not enabled", "accessnotconfigured", "container.googleapis.com"],
      title: "The Kubernetes Engine API isn't enabled",
      steps: [
        "Enable the Kubernetes Engine API for this project in the Google Cloud console.",
        "Wait a minute for it to propagate, then try again.",
      ],
      docsUrl: "https://console.cloud.google.com/apis/library/container.googleapis.com",
      docsLabel: "Enable the API",
    },
    {
      match: ["permission denied", "caller does not have permission", "permission_denied", "does not have permission"],
      title: "Your Google account can't list GKE clusters",
      steps: [
        "Grant your account container.clusters.list and container.clusters.get (for example the Kubernetes Engine Viewer role).",
        "Confirm the Kubernetes Engine API is enabled on the project.",
      ],
      docsUrl: "https://cloud.google.com/kubernetes-engine/docs/how-to/iam",
      docsLabel: "GKE IAM docs",
    },
  ],
};

export const azure: ProviderDescriptor = {
  id: "azure",
  displayName: "Azure AKS",
  binary: "az",
  extraBinaries: ["kubelogin"],
  installHelp: {
    macos: "brew install azure-cli",
    linux: "curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash",
    windows: "winget install --id Microsoft.AzureCLI",
    docsUrl: "https://learn.microsoft.com/cli/azure/install-azure-cli",
  },
  extraInstallHelp: {
    binary: "kubelogin",
    command: "az aks install-cli",
    docsUrl: "https://azure.github.io/kubelogin/install.html",
  },
  versionArgs: ["--version"],
  authCheckArgs: ["account", "show", "--output", "json"],
  loginHelp: {
    command: "az login",
    explanation: "Sign in to Azure in your browser.",
    docsUrl: "https://learn.microsoft.com/cli/azure/authenticate-azure-cli",
  },
  reloginHelp: {
    command: "az login",
    explanation: "Your Azure session expired. Re-run to sign in again.",
  },
  requiredParams: [],
  listClustersArgs: () => ["aks", "list", "--output", "json"],
  parseClusterList: (stdout) => {
    const arr = JSON.parse(stdout) as { name: string; location: string; resourceGroup: string }[];
    return arr.map((c) => ({ id: c.name, name: c.name, region: c.location, location: c.location, resourceGroup: c.resourceGroup }));
  },
  parseAccount: (stdout) => {
    const d = JSON.parse(stdout);
    return typeof d?.user?.name === "string" ? d.user.name : null;
  },
  connectArgs: (cluster) => ["aks", "get-credentials", "--resource-group", cluster.resourceGroup ?? "", "--name", cluster.name],
  authErrorPatterns: ["aadsts", "az login", "no subscription found"],
  consoleUrl: "https://portal.azure.com",
  errorHints: [
    {
      match: ["authorizationfailed", "does not have authorization to perform", "not authorized"],
      title: "Your Azure account can't list AKS clusters",
      steps: [
        "Ask an admin to grant your account the Azure Kubernetes Service Cluster User (or Reader) role on the subscription or resource group.",
        "Then try again.",
      ],
      docsUrl: "https://learn.microsoft.com/azure/aks/control-kubeconfig-access",
      docsLabel: "AKS access docs",
    },
    {
      match: ["no subscription found", "no subscriptions found", "please run 'az login'"],
      title: "No active Azure subscription",
      steps: [
        "Run az login and select a subscription that has AKS clusters.",
        "Then try again.",
      ],
      docsUrl: "https://learn.microsoft.com/cli/azure/authenticate-azure-cli",
      docsLabel: "Azure CLI auth docs",
    },
  ],
};

/** All providers Rigel can connect to today (DigitalOcean first). */
export const DESCRIPTORS: Record<string, ProviderDescriptor> = {
  digitalocean,
  aws,
  gcp,
  azure,
};

export function descriptorFor(provider: string): ProviderDescriptor | undefined {
  return DESCRIPTORS[provider];
}

export function listCloudProviders(): ProviderDescriptor[] {
  return Object.values(DESCRIPTORS);
}

export function diagnoseError(descriptor: ProviderDescriptor, stderr: string): ErrorHint | null {
  const lc = stderr.toLowerCase();
  return descriptor.errorHints?.find((h) => h.match.some((m) => lc.includes(m.toLowerCase()))) ?? null;
}
