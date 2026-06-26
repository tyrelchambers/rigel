import { test, expect } from "vitest";
import { descriptorFor, listCloudProviders, diagnoseError } from "./descriptors";

test("descriptorFor returns the DigitalOcean descriptor", () => {
  const d = descriptorFor("digitalocean");
  expect(d?.binary).toBe("doctl");
  expect(d?.requiredParams).toEqual([]);
  expect(d?.consoleUrl).toBe("https://cloud.digitalocean.com/kubernetes/clusters");
});

test("descriptorFor returns undefined for unknown/non-cloud providers", () => {
  expect(descriptorFor("local")).toBeUndefined();
});

test("DigitalOcean builds the expected list and connect argv", () => {
  const d = descriptorFor("digitalocean")!;
  expect(d.listClustersArgs({})).toEqual(["kubernetes", "cluster", "list", "-o", "json"]);
  expect(d.connectArgs({ id: "abc-123", name: "prod", region: "nyc1" }, {})).toEqual([
    "kubernetes", "cluster", "kubeconfig", "save", "abc-123",
  ]);
  expect(d.authCheckArgs).toEqual(["account", "get", "-o", "json"]);
});

test("DigitalOcean parseAccount extracts the email from auth-check JSON", () => {
  const d = descriptorFor("digitalocean")!;
  expect(d.parseAccount?.(JSON.stringify({ email: "me@example.com", uuid: "x" }))).toBe("me@example.com");
  expect(d.parseAccount?.(JSON.stringify({}))).toBeNull();
  expect(d.parseAccount?.(JSON.stringify({ uuid: "x" }))).toBeNull();
  // Array form (defensive guard)
  expect(d.parseAccount?.(JSON.stringify([{ email: "arr@example.com" }]))).toBe("arr@example.com");
});

test("DigitalOcean parses doctl JSON cluster output", () => {
  const d = descriptorFor("digitalocean")!;
  const stdout = JSON.stringify([
    { id: "abc-123", name: "prod", region: "nyc1", version: "1.30" },
    { id: "def-456", name: "stage", region: "sfo3", version: "1.30" },
  ]);
  expect(d.parseClusterList(stdout)).toEqual([
    { id: "abc-123", name: "prod", region: "nyc1" },
    { id: "def-456", name: "stage", region: "sfo3" },
  ]);
});

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

test("diagnoseError maps AWS access-denied to the EKS permissions hint", () => {
  const d = descriptorFor("aws")!;
  const stderr = "An error occurred (AccessDeniedException) when calling the ListClusters operation: User: arn:aws:iam::1:user/Admin is not authorized to perform: eks:ListClusters";
  const hint = diagnoseError(d, stderr);
  expect(hint?.title).toBe("Your AWS identity can't access EKS");
  expect(hint?.steps[0]).toMatch(/eks:ListClusters/);
  expect(hint?.docsUrl).toContain("aws.amazon.com");
});

test("diagnoseError maps GCP API-not-enabled before permission-denied", () => {
  const d = descriptorFor("gcp")!;
  const hint = diagnoseError(d, "Kubernetes Engine API has not been used in project foo before or it is disabled");
  expect(hint?.title).toBe("The Kubernetes Engine API isn't enabled");
});

test("diagnoseError maps Azure AuthorizationFailed", () => {
  const d = descriptorFor("azure")!;
  const hint = diagnoseError(d, "The client 'jane' does not have authorization to perform action ... (AuthorizationFailed)");
  expect(hint?.title).toBe("Your Azure account can't list AKS clusters");
});

test("diagnoseError returns null for an unrecognized error and for a provider with no hints", () => {
  expect(diagnoseError(descriptorFor("aws")!, "some totally unrelated message")).toBeNull();
  expect(diagnoseError(descriptorFor("digitalocean")!, "anything")).toBeNull();
});

test("diagnoseError prefers GCP api-not-enabled even when the message also says permission denied", () => {
  const d = descriptorFor("gcp")!;
  const stderr = "Kubernetes Engine API has not been used in project foo before or it is disabled. PERMISSION_DENIED";
  expect(diagnoseError(d, stderr)?.title).toBe("The Kubernetes Engine API isn't enabled");
});

test("diagnoseError maps an AWS expired session", () => {
  const d = descriptorFor("aws")!;
  const hint = diagnoseError(d, "The security token included in the request is expired");
  expect(hint?.title).toBe("Your AWS session expired");
});

test("diagnoseError maps an Azure missing subscription", () => {
  const d = descriptorFor("azure")!;
  const hint = diagnoseError(d, "No subscription found. Run 'az account set' to set a subscription.");
  expect(hint?.title).toBe("No active Azure subscription");
});
