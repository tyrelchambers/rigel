# AWS / GCP / Azure cloud-connect providers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Amazon EKS, Google GKE, and Azure AKS as cloud-connect providers on the existing engine, with a wizard "pick params" step (region/project dropdowns) and an extra-binary install panel.

**Architecture:** Each provider is a descriptor (data) in `@rigel/cloud-connect`. The engine already threads `params` through list/connect at the descriptor + server level; this plan extends the descriptor type (`ParamSpec[]` params, `extraInstallHelp`, per-cluster `location`/`resourceGroup`), adds a `cloudParamOptions` server fn + route, and adds the params phase + extra-binary panel to the web `ConnectWizard`. Auth stays shell-out; Rigel stores no cloud credentials.

**Tech Stack:** TypeScript, Node `handler(req)` routes (`apps/server`), React + TanStack Query (`apps/web`), Vitest (colocated `*.test.ts`, jsdom for components), pnpm workspaces.

---

## File structure

**Modify — `packages/cloud-connect/src/`:**
- `types.ts` — `ParamSpec`, `ExtraInstallHelp`; `requiredParams: ParamSpec[]`; `extraInstallHelp?`; `CloudCluster.location?`/`.resourceGroup?`.
- `descriptors.ts` — add `aws`, `gcp`, `azure` (+ `AWS_REGIONS`) to `DESCRIPTORS`.
- `descriptors.test.ts` — per-provider arg/parse tests; update the DO-only assertions.

**Modify — `apps/server/src/`:**
- `cloudConnect.ts` — `cloudCheck` robustness (authenticated ⇒ resolvable account), AWS region stamping in `cloudListClusters`, new `cloudParamOptions`.
- `cloudConnect.test.ts` — update two `cloudCheck` tests; add `cloudParamOptions` + stamping tests.
- `index.ts` — register `POST /api/cloud/param-options`.

**Modify — `apps/web/src/`:**
- `lib/api.ts` — `params` arg on `cloudListClusters`/`cloudConnect`; add `cloudParamOptions`.
- `shell/ConnectWizard.tsx` — thread `params` through `Actions`; the `needs-params` phase; split the `needs-extra` panel.
- `shell/ConnectWizard.test.tsx` — params-phase + needs-extra tests; update the connect assertion for the `params` arg.
- `shell/ConnectClusterModal.tsx` — empty `COMING_SOON`.
- `shell/ConnectClusterModal.test.tsx` — assert four live tiles, no "coming soon".

---

## Task 1: Descriptor type extensions

**Files:** Modify `packages/cloud-connect/src/types.ts`

- [ ] **Step 1: Edit `types.ts`** — extend `CloudCluster`, add `ParamSpec` + `ExtraInstallHelp`, and change `requiredParams` + add `extraInstallHelp` on `ProviderDescriptor`.

Replace the `CloudCluster` interface with:
```ts
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
```

Add (after `CommandHelp`):
```ts
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
```

In `ProviderDescriptor`, change the `requiredParams` line from `requiredParams: string[];` to:
```ts
  /** Params the user picks before listing (DigitalOcean/Azure: []). */
  requiredParams: ParamSpec[];
  /** Install help for the extra binary, shown in the needs-extra panel. */
  extraInstallHelp?: ExtraInstallHelp;
```

- [ ] **Step 2: Typecheck** — the DigitalOcean descriptor's `requiredParams: []` is valid for `ParamSpec[]`, so no descriptor change is needed yet.

Run: `pnpm -C packages/cloud-connect typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**
```bash
git add packages/cloud-connect/src/types.ts
git commit -m "feat(cloud-connect): ParamSpec, extraInstallHelp, per-cluster location/resourceGroup"
```

---

## Task 2: AWS (EKS) descriptor

**Files:** Modify `packages/cloud-connect/src/descriptors.ts`, `packages/cloud-connect/src/descriptors.test.ts`

- [ ] **Step 1: Write the failing test** (append to `descriptors.test.ts`)
```ts
test("AWS descriptor builds list/connect argv and parses EKS output", () => {
  const d = descriptorFor("aws")!;
  expect(d.binary).toBe("aws");
  expect(d.listClustersArgs({ region: "us-east-1" })).toEqual([
    "eks", "list-clusters", "--region", "us-east-1", "--output", "json",
  ]);
  // EKS list-clusters returns names only:
  expect(d.parseClusterList(JSON.stringify({ clusters: ["prod", "stage"] }))).toEqual([
    { id: "prod", name: "prod", region: "" },
    { id: "stage", name: "stage", region: "" },
  ]);
  expect(d.connectArgs({ id: "prod", name: "prod", region: "" }, { region: "us-east-1" })).toEqual([
    "eks", "update-kubeconfig", "--region", "us-east-1", "--name", "prod",
  ]);
  expect(d.parseAccount!(JSON.stringify({ Account: "123", Arn: "arn:aws:iam::123:user/jane" }))).toBe("arn:aws:iam::123:user/jane");
  expect(d.requiredParams[0]!.key).toBe("region");
  expect(d.requiredParams[0]!.staticOptions).toContain("us-east-1");
});
```

- [ ] **Step 2: Run it (fails)** — `pnpm -C packages/cloud-connect exec vitest run src/descriptors.test.ts` → FAIL (`descriptorFor("aws")` is undefined).

- [ ] **Step 3: Add the AWS descriptor** to `descriptors.ts` (after the `digitalocean` const, before `DESCRIPTORS`):
```ts
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
};
```

Then add `aws` to the `DESCRIPTORS` record:
```ts
export const DESCRIPTORS: Record<string, ProviderDescriptor> = {
  digitalocean,
  aws,
};
```

- [ ] **Step 4: Run it (passes)** — `pnpm -C packages/cloud-connect exec vitest run src/descriptors.test.ts` → the AWS test passes. (The existing `descriptorFor("aws")).toBeUndefined()` assertion now FAILS — fix in Task 4 when all three land; for now you may see one failing assertion on the old line. To keep this task green in isolation, also update that line now: change `expect(descriptorFor("aws")).toBeUndefined(); // fast-follow, not built yet` to `expect(descriptorFor("local")).toBeUndefined();`.)

- [ ] **Step 5: Commit**
```bash
git add packages/cloud-connect/src/descriptors.ts packages/cloud-connect/src/descriptors.test.ts
git commit -m "feat(cloud-connect): Amazon EKS descriptor"
```

---

## Task 3: GCP (GKE) descriptor

**Files:** Modify `packages/cloud-connect/src/descriptors.ts`, `packages/cloud-connect/src/descriptors.test.ts`

- [ ] **Step 1: Write the failing test** (append to `descriptors.test.ts`)
```ts
test("GCP descriptor builds list/connect argv with project + location", () => {
  const d = descriptorFor("gcp")!;
  expect(d.binary).toBe("gcloud");
  expect(d.extraBinaries).toEqual(["gke-gcloud-auth-plugin"]);
  expect(d.extraInstallHelp?.command).toBe("gcloud components install gke-gcloud-auth-plugin");
  expect(d.listClustersArgs({ project: "my-proj" })).toEqual([
    "container", "clusters", "list", "--project", "my-proj", "--format=json",
  ]);
  expect(d.parseClusterList(JSON.stringify([{ name: "prod", location: "us-central1" }]))).toEqual([
    { id: "prod", name: "prod", region: "us-central1", location: "us-central1" },
  ]);
  expect(d.connectArgs({ id: "prod", name: "prod", region: "us-central1", location: "us-central1" }, { project: "my-proj" })).toEqual([
    "container", "clusters", "get-credentials", "prod", "--location", "us-central1", "--project", "my-proj",
  ]);
  expect(d.parseAccount!("jane@example.com\n")).toBe("jane@example.com");
  expect(d.parseAccount!("(unset)\n")).toBeNull();
  expect(d.requiredParams[0]!.key).toBe("project");
  expect(d.requiredParams[0]!.optionsArgs).toEqual(["projects", "list", "--format=value(projectId)"]);
});
```

- [ ] **Step 2: Run it (fails)** — `descriptorFor("gcp")` undefined.

- [ ] **Step 3: Add the GCP descriptor** to `descriptors.ts`:
```ts
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
};
```

Add `gcp` to `DESCRIPTORS`:
```ts
export const DESCRIPTORS: Record<string, ProviderDescriptor> = {
  digitalocean,
  aws,
  gcp,
};
```

> Note: `gcloud config get-value account` exits 0 even when not logged in (printing `(unset)`). The Task 5 `cloudCheck` change makes "authenticated" require a resolvable account (`parseAccount` non-null), so the `(unset)` case correctly reports not-authenticated.

- [ ] **Step 4: Run it (passes).** `pnpm -C packages/cloud-connect exec vitest run src/descriptors.test.ts`.

- [ ] **Step 5: Commit**
```bash
git add packages/cloud-connect/src/descriptors.ts packages/cloud-connect/src/descriptors.test.ts
git commit -m "feat(cloud-connect): Google GKE descriptor (+ gke-gcloud-auth-plugin)"
```

---

## Task 4: Azure (AKS) descriptor + finalize the registry

**Files:** Modify `packages/cloud-connect/src/descriptors.ts`, `packages/cloud-connect/src/descriptors.test.ts`

- [ ] **Step 1: Write the failing test** (append)
```ts
test("Azure descriptor lists clusters with resource group, no params", () => {
  const d = descriptorFor("azure")!;
  expect(d.binary).toBe("az");
  expect(d.extraBinaries).toEqual(["kubelogin"]);
  expect(d.requiredParams).toEqual([]);
  expect(d.listClustersArgs({})).toEqual(["aks", "list", "--output", "json"]);
  expect(d.parseClusterList(JSON.stringify([{ name: "prod", location: "eastus", resourceGroup: "rg1" }]))).toEqual([
    { id: "prod", name: "prod", region: "eastus", location: "eastus", resourceGroup: "rg1" },
  ]);
  expect(d.connectArgs({ id: "prod", name: "prod", region: "eastus", resourceGroup: "rg1" }, {})).toEqual([
    "aks", "get-credentials", "--resource-group", "rg1", "--name", "prod",
  ]);
  expect(d.parseAccount!(JSON.stringify({ user: { name: "jane@contoso.com" } }))).toBe("jane@contoso.com");
});

test("listCloudProviders returns all four providers", () => {
  expect(listCloudProviders().map((d) => d.id).sort()).toEqual(["aws", "azure", "digitalocean", "gcp"]);
});
```

- [ ] **Step 2: Run it (fails).**

- [ ] **Step 3: Add the Azure descriptor** + register:
```ts
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
};

export const DESCRIPTORS: Record<string, ProviderDescriptor> = {
  digitalocean,
  aws,
  gcp,
  azure,
};
```

- [ ] **Step 4: Run the full package suite.** `pnpm -C packages/cloud-connect test` → all pass (verify the `listCloudProviders` test and that no stale DO-only assertion remains; if `listCloudProviders().map(...).toEqual(["digitalocean"])` still exists from before, it's now replaced by the new sorted-four assertion — delete the old one if present).

- [ ] **Step 5: Commit**
```bash
git add packages/cloud-connect/src/descriptors.ts packages/cloud-connect/src/descriptors.test.ts
git commit -m "feat(cloud-connect): Azure AKS descriptor; all four providers registered"
```

---

## Task 5: Server `cloudCheck` robustness + AWS region stamping

**Files:** Modify `apps/server/src/cloudConnect.ts`, `apps/server/src/cloudConnect.test.ts`

- [ ] **Step 1: Edit `cloudCheck`** in `cloudConnect.ts` so "authenticated" requires a resolvable account when the descriptor has a `parseAccount`. Replace the `if (cliInstalled) { ... }` block with:
```ts
  let authenticated = false;
  let account: string | null | undefined;
  if (cliInstalled) {
    const a = await run(d.binary, d.authCheckArgs);
    if (a.code === 0) {
      if (d.parseAccount) {
        try { account = d.parseAccount(a.stdout); } catch { account = null; }
        authenticated = account != null;
      } else {
        authenticated = true;
      }
    }
  }
  return { cliInstalled, extraBinariesInstalled, authenticated, ...(account ? { account } : {}) };
```
(This makes a CLI that exits 0 but has no resolvable identity — e.g. `gcloud config get-value account` → `(unset)` — report not-authenticated.)

- [ ] **Step 2: Stamp the region in `cloudListClusters`** so AWS (whose EKS list payload has no region) shows it. Replace the `try { return { clusters: d.parseClusterList(res.stdout) }; }` with:
```ts
  try {
    const clusters = d.parseClusterList(res.stdout).map((c) =>
      c.region || !params.region ? c : { ...c, region: params.region });
    return { clusters };
  } catch {
    return { error: "could not parse cluster list", stderr: res.stdout };
  }
```

- [ ] **Step 3: Update the two affected `cloudCheck` tests** in `cloudConnect.test.ts`:

(a) The "installed + authenticated when both probes exit 0" test must now return a parseable account for the auth call:
```ts
test("cloudCheck reports installed + authenticated with a resolvable account", async () => {
  const run: Run = async (_bin, args) =>
    args[0] === "account" ? ok(JSON.stringify({ email: "a@b.com" })) : ok();
  expect(await cloudCheck("digitalocean", run)).toEqual({
    cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "a@b.com",
  });
});
```

(b) The "stays authenticated with no account key when stdout is not valid JSON" test inverts: an exit-0 auth check with no resolvable account is now NOT authenticated:
```ts
test("cloudCheck reports not-authenticated when the auth-check has no resolvable account", async () => {
  const run: Run = async (_bin, args) => (args[0] === "account" ? ok("") : ok());
  const result = await cloudCheck("digitalocean", run);
  expect(result.authenticated).toBe(false);
  expect("account" in result).toBe(false);
});
```

- [ ] **Step 4: Add a region-stamping test:**
```ts
test("cloudListClusters stamps the region from params when the list payload omits it", async () => {
  const run: Run = async () => ok(JSON.stringify({ clusters: ["prod"] }));
  expect(await cloudListClusters("aws", { region: "us-east-1" }, run)).toEqual({
    clusters: [{ id: "prod", name: "prod", region: "us-east-1" }],
  });
});
```

- [ ] **Step 5: Run** `pnpm -C apps/server exec vitest run src/cloudConnect.test.ts` → all pass.

- [ ] **Step 6: Commit**
```bash
git add apps/server/src/cloudConnect.ts apps/server/src/cloudConnect.test.ts
git commit -m "fix(server): cloudCheck requires a resolvable account; stamp AWS region"
```

---

## Task 6: Server `cloudParamOptions`

**Files:** Modify `apps/server/src/cloudConnect.ts`, `apps/server/src/cloudConnect.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `cloudConnect.test.ts`; import `cloudParamOptions` from `./cloudConnect`):
```ts
test("cloudParamOptions returns AWS static regions + the configured default", async () => {
  const run: Run = async (_bin, args) =>
    args.join(" ") === "configure get region" ? ok("eu-west-1\n") : fail("unexpected");
  const r = await cloudParamOptions("aws", "region", run);
  expect(r.options).toContain("us-east-1");
  expect(r.default).toBe("eu-west-1");
});

test("cloudParamOptions fetches GCP projects + default, ignoring (unset)", async () => {
  const run: Run = async (_bin, args) =>
    args[0] === "projects" ? ok("proj-a\nproj-b\n") : ok("(unset)\n");
  const r = await cloudParamOptions("gcp", "project", run);
  expect(r.options).toEqual(["proj-a", "proj-b"]);
  expect(r.default).toBeUndefined();
});

test("cloudParamOptions returns empty options for an unknown provider/param", async () => {
  const run: Run = async () => ok();
  expect(await cloudParamOptions("azure", "region", run)).toEqual({ options: [] });
});
```

- [ ] **Step 2: Run (fails)** — `cloudParamOptions` not exported.

- [ ] **Step 3: Add `cloudParamOptions`** to `cloudConnect.ts` (after `cloudListClusters`). It needs `descriptorFor` (already imported):
```ts
export interface ParamOptions {
  options: string[];
  default?: string;
}

/** Fetch the dropdown options + pre-selected default for a provider's required param. */
export async function cloudParamOptions(provider: string, key: string, run: Run = runProcess): Promise<ParamOptions> {
  const d = descriptorFor(provider);
  const spec = d?.requiredParams.find((p) => p.key === key);
  if (!d || !spec) return { options: [] };
  let options: string[] = spec.staticOptions ?? [];
  if (spec.optionsArgs) {
    const res = await run(d.binary, spec.optionsArgs);
    if (res.code === 0) {
      options = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  }
  let def: string | undefined;
  if (spec.defaultArgs) {
    const r = await run(d.binary, spec.defaultArgs);
    if (r.code === 0) {
      const v = r.stdout.trim();
      if (v && v !== "(unset)") def = v;
    }
  }
  return { options, ...(def ? { default: def } : {}) };
}
```

- [ ] **Step 4: Run (passes).** `pnpm -C apps/server exec vitest run src/cloudConnect.test.ts`.

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/cloudConnect.ts apps/server/src/cloudConnect.test.ts
git commit -m "feat(server): cloudParamOptions (region/project dropdown sources)"
```

---

## Task 7: `/api/cloud/param-options` route

**Files:** Modify `apps/server/src/index.ts`

- [ ] **Step 1: Add `cloudParamOptions` to the cloudConnect import** (the `import { cloudCheck, cloudListClusters, ... } from "./cloudConnect";` block):
```ts
import {
  cloudCheck, cloudListClusters, cloudConnect, cloudHealth, importKubeconfig, cloudParamOptions,
} from "./cloudConnect";
```

- [ ] **Step 2: Add the route** (place it right after the `POST /api/cloud/clusters` block):
```ts
    // POST /api/cloud/param-options { provider, key } — dropdown options + default
    // for a required connect param (AWS region, GCP project). Read-only. 200.
    if (url.pathname === "/api/cloud/param-options" && req.method === "POST") {
      let body: { provider?: string; key?: string };
      try { body = (await req.json()) as typeof body; }
      catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.provider !== "string" || typeof body.key !== "string") {
        return Response.json({ error: "provider and key required" }, { status: 422 });
      }
      return Response.json(await cloudParamOptions(body.provider, body.key));
    }
```

- [ ] **Step 3: Typecheck + server suite.** `pnpm -C apps/server typecheck && pnpm -C apps/server test` → clean + green.

- [ ] **Step 4: Commit**
```bash
git add apps/server/src/index.ts
git commit -m "feat(server): /api/cloud/param-options route"
```

---

## Task 8: Web API — params on list/connect + `cloudParamOptions`

**Files:** Modify `apps/web/src/lib/api.ts`

- [ ] **Step 1: Edit the cloud section** of `api.ts`. Change `cloudListClusters` and `cloudConnect` to accept `params`, and add `cloudParamOptions`:
```ts
export const cloudListClusters = (provider: CloudProvider, params: Record<string, string> = {}) =>
  postJson<{ clusters?: CloudCluster[]; error?: string; stderr?: string }>(
    "/api/cloud/clusters", { provider, params },
  );

export async function cloudConnect(provider: CloudProvider, cluster: CloudCluster, params: Record<string, string> = {}) {
  const r = await postJson<{ context?: string; backupPath?: string | null; error?: string; stderr?: string }>(
    "/api/cloud/connect", { provider, cluster, params },
  );
  if (r.error) throw new Error(r.stderr || r.error);
  return r;
}

export interface ParamOptions { options: string[]; default?: string }
export const cloudParamOptions = (provider: CloudProvider, key: string) =>
  postJson<ParamOptions>("/api/cloud/param-options", { provider, key });
```

- [ ] **Step 2: Typecheck.** `pnpm -C apps/web typecheck` → clean (the default `= {}` keeps any existing 2-arg callers compiling).

- [ ] **Step 3: Commit**
```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): thread params through cloud list/connect; add cloudParamOptions"
```

---

## Task 9: ConnectWizard — params phase + params threading

**Files:** Modify `apps/web/src/shell/ConnectWizard.tsx`, `apps/web/src/shell/ConnectWizard.test.tsx`

- [ ] **Step 1: Update imports + `Actions` + `defaultActions` + `Phase`** in `ConnectWizard.tsx`.

Add `ParamSpec` to the `@rigel/cloud-connect/src/index` type import. Add `cloudParamOptions as defaultParamOptions` to the `@/lib/api` import.

Replace the `Actions` interface, `defaultActions`, and `Phase`:
```ts
interface Actions {
  check: (provider: CloudProvider) => Promise<CheckResult>;
  list: (provider: CloudProvider, params: Record<string, string>) => Promise<{ clusters?: CloudCluster[]; error?: string; stderr?: string }>;
  connect: (provider: CloudProvider, cluster: CloudCluster, params: Record<string, string>) => Promise<{ context?: string; backupPath?: string | null }>;
  paramOptions: (provider: CloudProvider, key: string) => Promise<{ options: string[]; default?: string }>;
}

const defaultActions: Actions = {
  check: defaultCheck, list: defaultList, connect: defaultConnect, paramOptions: defaultParamOptions,
};

type Phase = "checking" | "needs-cli" | "needs-extra" | "needs-login" | "needs-params" | "listing" | "pick" | "connecting" | "error";

type ParamField = { spec: ParamSpec; options: string[]; value: string };
```

- [ ] **Step 2: Add state + refactor `runCheck`/`connect`** in the component body. Add state:
```ts
  const [paramFields, setParamFields] = useState<ParamField[]>([]);
  const [params, setParams] = useState<Record<string, string>>({});
```

Replace `runCheck` with a version that branches to params, and add a `listClusters` helper:
```ts
  async function listClusters(p: Record<string, string>) {
    setParams(p);
    setPhase("listing");
    try {
      const res = await actions.list(provider, p);
      if (res.error) { setError(res.stderr || res.error); setPhase("error"); return; }
      setClusters(res.clusters ?? []);
      setPhase("pick");
    } catch (e) {
      setError(e instanceof Error ? e.message : "list failed");
      setPhase("error");
    }
  }

  async function runCheck() {
    setPhase("checking");
    setError(null);
    try {
      const check = await actions.check(provider);
      setAccount(check.account ?? null);
      const step = nextStepFromCheck(check);
      if (step !== "ready") { setPhase(step); return; }
      if (descriptor.requiredParams.length > 0) {
        const fields: ParamField[] = [];
        for (const spec of descriptor.requiredParams) {
          const opts = await actions.paramOptions(provider, spec.key);
          const options = opts.default && !opts.options.includes(opts.default)
            ? [opts.default, ...opts.options]
            : opts.options;
          fields.push({ spec, options, value: opts.default ?? options[0] ?? "" });
        }
        setParamFields(fields);
        setPhase("needs-params");
        return;
      }
      await listClusters({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "check failed");
      setPhase("error");
    }
  }
```

Change the `connect` function's `actions.connect(provider, cluster)` call to pass `params`:
```ts
      const r = await actions.connect(provider, cluster, params);
```

- [ ] **Step 3: Add the `needs-params` render branch** (place it before the `needs-login` branch). It renders a native `<select>` per param (accessible + testable), pre-selected to the default, plus a Continue button:
```ts
  if (phase === "needs-params") {
    const submit = () => void listClusters(Object.fromEntries(paramFields.map((f) => [f.spec.key, f.value])));
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {paramFields.map((f, i) => (
          <div key={f.spec.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor={`param-${f.spec.key}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {f.spec.label}
            </label>
            <select
              id={`param-${f.spec.key}`}
              value={f.value}
              onChange={(e) => {
                const v = e.target.value;
                setParamFields((prev) => prev.map((p, j) => (j === i ? { ...p, value: v } : p)));
              }}
              style={{
                width: "100%", appearance: "none", cursor: "pointer",
                background: "var(--surface-sunken)", color: "var(--fg-primary)",
                border: "1px solid var(--border-strong)", borderRadius: 8,
                padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 13,
              }}
            >
              {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <span style={{ fontSize: 11.5, color: "var(--fg-tertiary)", lineHeight: 1.4 }}>
              Pre-selected from your {descriptor.displayName} CLI config.
            </span>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button onClick={submit}>Continue</Button>
        </div>
      </div>
    );
  }
```

- [ ] **Step 4: Write the params-phase tests** (append to `ConnectWizard.test.tsx`). Use the `aws` descriptor (region param):
```ts
const awsDesc = descriptorFor("aws")!;

test("AWS shows a region dropdown then lists with the chosen region", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "arn:aws:iam::1:user/jane" }),
    paramOptions: vi.fn().mockResolvedValue({ options: ["us-east-1", "eu-west-1"], default: "eu-west-1" }),
    list: vi.fn().mockResolvedValue({ clusters: [{ id: "prod", name: "prod", region: "eu-west-1" }] }),
    connect: vi.fn().mockResolvedValue({ context: "ctx", backupPath: null }),
  };
  wrap(<ConnectWizard descriptor={awsDesc} actions={actions} onConnected={vi.fn()} />);

  // dropdown pre-selected to the default
  const select = await screen.findByLabelText(/region/i);
  expect((select as HTMLSelectElement).value).toBe("eu-west-1");
  fireEvent.change(select, { target: { value: "us-east-1" } });
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));

  await waitFor(() => expect(actions.list).toHaveBeenCalledWith("aws", { region: "us-east-1" }));
  await waitFor(() => expect(screen.getByText("prod")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /connect prod/i }));
  await waitFor(() => expect(actions.connect).toHaveBeenCalledWith("aws", { id: "prod", name: "prod", region: "eu-west-1" }, { region: "us-east-1" }));
});
```

- [ ] **Step 5: Update the existing DigitalOcean connect assertion** in `ConnectWizard.test.tsx` (the "lists clusters and connects the chosen one" test) — `actions.connect` now receives a third `params` arg `{}`:
```ts
  await waitFor(() => expect(actions.connect).toHaveBeenCalledWith("digitalocean", { id: "abc", name: "prod", region: "nyc1" }, {}));
```
Also add `paramOptions: vi.fn()` to **every** existing test's `actions` object in `ConnectWizard.test.tsx` (the install-help, login-help, lists-and-connects, empty-state, and no-account tests) — the `Actions` interface now requires `paramOptions`, so any `actions` object missing it is a TS error. DO/its tests never call it, but the type requires it.

- [ ] **Step 6: Run** `pnpm -C apps/web exec vitest run src/shell/ConnectWizard.test.tsx` → all pass. Then `pnpm -C apps/web typecheck`.

- [ ] **Step 7: Commit**
```bash
git add apps/web/src/shell/ConnectWizard.tsx apps/web/src/shell/ConnectWizard.test.tsx
git commit -m "feat(web): connect wizard params step (region/project dropdown)"
```

---

## Task 10: ConnectWizard — split the `needs-extra` panel

**Files:** Modify `apps/web/src/shell/ConnectWizard.tsx`, `apps/web/src/shell/ConnectWizard.test.tsx`

- [ ] **Step 1: Split the shared `needs-cli || needs-extra` branch.** Change the guard from `if (phase === "needs-cli" || phase === "needs-extra")` to `if (phase === "needs-cli")` (leaving that branch otherwise unchanged), then add a dedicated `needs-extra` branch right after it that renders `descriptor.extraInstallHelp`:
```ts
  if (phase === "needs-extra" && descriptor.extraInstallHelp) {
    const x = descriptor.extraInstallHelp;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-primary)" }}>Install {x.binary}</div>
          <div style={{ fontSize: 13, color: "var(--fg-secondary)", lineHeight: 1.5 }}>
            kubectl needs {x.binary} to reach {descriptor.displayName} clusters. Install it, then re-check.
          </div>
        </div>
        <CommandField command={x.command} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <a href={x.docsUrl} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--accent-primary)", textDecoration: "none" }}>
            Plugin docs <ExternalLink size={11} />
          </a>
          <Button onClick={() => void runCheck()}>Re-check</Button>
        </div>
      </div>
    );
  }
```
(If a future provider somehow reaches `needs-extra` without `extraInstallHelp`, it falls through to the `pick` branch harmlessly; in practice only GCP/Azure reach `needs-extra`, and both define `extraInstallHelp`.)

- [ ] **Step 2: Write the test** (append to `ConnectWizard.test.tsx`) using the `gcp` descriptor with `extraBinariesInstalled: false`:
```ts
const gcpDesc = descriptorFor("gcp")!;

test("GCP shows the extra-binary install panel when the plugin is missing", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: false, authenticated: false }),
    paramOptions: vi.fn(), list: vi.fn(), connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={gcpDesc} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/install gke-gcloud-auth-plugin/i)).toBeInTheDocument());
  expect(screen.getByText("gcloud components install gke-gcloud-auth-plugin")).toBeInTheDocument();
});
```

- [ ] **Step 3: Run** `pnpm -C apps/web exec vitest run src/shell/ConnectWizard.test.tsx` → all pass; `pnpm -C apps/web typecheck`.

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/shell/ConnectWizard.tsx apps/web/src/shell/ConnectWizard.test.tsx
git commit -m "feat(web): dedicated extra-binary install panel (GKE plugin / kubelogin)"
```

---

## Task 11: ConnectClusterModal — enable the three tiles

**Files:** Modify `apps/web/src/shell/ConnectClusterModal.tsx`, `apps/web/src/shell/ConnectClusterModal.test.tsx`

- [ ] **Step 1: Update the test** (`ConnectClusterModal.test.tsx`) — the four providers are now live, no "coming soon":
```ts
test("renders all four providers + import, none coming soon", () => {
  wrap(<ConnectClusterModal open onOpenChange={vi.fn()} />);
  for (const name of [/digitalocean/i, /amazon eks/i, /google gke/i, /azure aks/i, /import a kubeconfig/i]) {
    expect(screen.getByRole("button", { name })).toBeEnabled();
  }
  expect(screen.queryByText(/coming soon/i)).toBeNull();
});
```
(Replace the prior test that asserted EKS/GKE/AKS were disabled.)

- [ ] **Step 2: Run it (fails)** — the tiles are still disabled via `COMING_SOON`.

- [ ] **Step 3: Empty `COMING_SOON`** in `ConnectClusterModal.tsx`. Change:
```ts
const COMING_SOON: { id: IconId; label: string }[] = [];
```
The `providers.map(...)` already renders aws/gcp/azure as enabled tiles (they're now in `DESCRIPTORS`), and the empty `COMING_SOON.map(...)` renders nothing. (Leave the `.map` in place — it's a harmless no-op — or remove it; keeping it is fine.)

- [ ] **Step 4: Run it (passes).** `pnpm -C apps/web exec vitest run src/shell/ConnectClusterModal.test.tsx`.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/shell/ConnectClusterModal.tsx apps/web/src/shell/ConnectClusterModal.test.tsx
git commit -m "feat(web): enable AWS/GCP/Azure provider tiles in the connect grid"
```

---

## Task 12: Full verification + manual note

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the repo.** `pnpm -r typecheck` → no errors.
- [ ] **Step 2: Full test suite.** `pnpm -r test` → all packages pass (new: cloud-connect descriptor tests for 3 providers; server cloudCheck/stamping/paramOptions; web wizard params + needs-extra + grid).
- [ ] **Step 3: Build.** `pnpm -r build` → succeeds.
- [ ] **Step 4: Desktop smoke.** `pnpm --filter desktop dev` → rail `+` → Connect existing → the grid now shows **DigitalOcean, Amazon EKS, Google GKE, Azure AKS** (all enabled) + Import. Picking AWS (with the `aws` CLI present + logged in) shows the **region dropdown** pre-selected to your configured region → Continue → cluster list. Picking GCP without the plugin shows the **Install gke-gcloud-auth-plugin** panel.
- [ ] **Step 5: Manual end-to-end note.** Real EKS/GKE/AKS connect needs the `aws`/`gcloud`/`az` CLIs + accounts (not on the dev machine), so live connect is a **manual verification step** (as DigitalOcean was). Everything reachable here is typechecked, unit-tested, and built.
- [ ] **Step 6: Final commit (if any fixups)**
```bash
git add -A && git commit -m "chore(cloud-providers): verification fixups" || echo "nothing to commit"
```

---

## Out of scope (carried from the spec)

- Cloud cluster **creation**; **token minting / self-auth** (still shell-out only).
- AKS **`--admin`** path, EKS **access-entry management** (only the RBAC caveat is surfaced in help).
- Subscription/project **switching** UI beyond the active one (the "switch account" chip covers re-auth).
- The Pencil params-step's decorative **pin icon + "Default" pill** — the implementation uses a native `<select>` (accessible/testable) with the pre-selected default + a "pre-selected from your CLI config" hint; the pill/pin are optional polish, deferred.

## Notes

- **Pencil-designed surfaces** (already mocked): the params step (`Modal — EKS pick region`) and the extra-binary panel (`Modal — GKE auth plugin`). The implementation here matches their structure (labelled pre-selected dropdown; single-command install card + docs + Re-check).
- DigitalOcean behavior is unchanged (no params, no extra binary). Azure is paramless (its `aks list` returns all clusters), so it skips the params step like DigitalOcean.
