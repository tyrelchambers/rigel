// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectWizard } from "./ConnectWizard";
import { descriptorFor } from "@rigel/cloud-connect/src/index";

const doDesc = descriptorFor("digitalocean")!;
const awsDesc = descriptorFor("aws")!;
const gcpDesc = descriptorFor("gcp")!;
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

test("shows install help when the CLI is missing", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: false, extraBinariesInstalled: true, authenticated: false }),
    list: vi.fn(), connect: vi.fn(), paramOptions: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/brew install doctl/i)).toBeInTheDocument());
});

test("install panel shows all three platform commands", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: false, extraBinariesInstalled: true, authenticated: false }),
    list: vi.fn(), connect: vi.fn(), paramOptions: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => {
    expect(screen.getByText(/brew install doctl/i)).toBeInTheDocument();
    expect(screen.getByText(/snap install doctl/i)).toBeInTheDocument();
    expect(screen.getByText(/scoop install doctl/i)).toBeInTheDocument();
  });
});

test("install panel shows Windows alternative command", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: false, extraBinariesInstalled: true, authenticated: false }),
    list: vi.fn(), connect: vi.fn(), paramOptions: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);
  // The alt line shows "or  choco install doctl" (secondary muted text)
  await waitFor(() => expect(screen.getByText(/choco install doctl/i)).toBeInTheDocument());
});

test("install panel renders three Copy buttons", async () => {
  // Stub navigator.clipboard so the copy handler doesn't throw in jsdom
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: false, extraBinariesInstalled: true, authenticated: false }),
    list: vi.fn(), connect: vi.fn(), paramOptions: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => {
    const copyBtns = screen.getAllByRole("button", { name: /copy/i });
    expect(copyBtns).toHaveLength(3);
  });
});

test("shows login help when not authenticated", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: false }),
    list: vi.fn(), connect: vi.fn(), paramOptions: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/doctl auth init/i)).toBeInTheDocument());
});

test("lists clusters and connects the chosen one", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "me@example.com" }),
    list: vi.fn().mockResolvedValue({ clusters: [{ id: "abc", name: "prod", region: "nyc1" }] }),
    connect: vi.fn().mockResolvedValue({ context: "do-nyc1-prod", backupPath: null }),
    paramOptions: vi.fn(),
  };
  const onConnected = vi.fn();
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={onConnected} />);

  await waitFor(() => expect(screen.getByText("prod")).toBeInTheDocument());
  expect(screen.getByText(/connected as me@example\.com/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /connect prod/i }));
  await waitFor(() => expect(actions.connect).toHaveBeenCalledWith("digitalocean", { id: "abc", name: "prod", region: "nyc1" }, {}));
  await waitFor(() => expect(onConnected).toHaveBeenCalledWith("do-nyc1-prod"));
});

test("shows self-explaining empty state with account when no clusters", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "me@example.com" }),
    list: vi.fn().mockResolvedValue({ clusters: [] }),
    connect: vi.fn(), paramOptions: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);

  await waitFor(() => expect(screen.getByText(/no clusters in this account/i)).toBeInTheDocument());
  expect(screen.getByText("me@example.com")).toBeInTheDocument();

  const consoleLink = screen.getByRole("link", { name: /open digitalocean/i });
  expect(consoleLink).toBeInTheDocument();
  expect(consoleLink).toHaveAttribute("href", "https://cloud.digitalocean.com/kubernetes/clusters");

  expect(screen.getByRole("button", { name: /re-check/i })).toBeInTheDocument();
  expect(screen.getByText("doctl auth init")).toBeInTheDocument();
});

test("empty state omits the console link when the descriptor has no consoleUrl", async () => {
  const noConsole = { ...doDesc, consoleUrl: undefined };
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "me@example.com" }),
    list: vi.fn().mockResolvedValue({ clusters: [] }),
    connect: vi.fn(), paramOptions: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={noConsole} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/no clusters in this account/i)).toBeInTheDocument());
  expect(screen.getByText("me@example.com")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /re-check/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /open/i })).toBeNull();
});

test("does not show a connected-as row when the check has no account", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true }),
    list: vi.fn().mockResolvedValue({ clusters: [{ id: "abc", name: "prod", region: "nyc1" }] }),
    connect: vi.fn(), paramOptions: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);

  await waitFor(() => expect(screen.getByText("prod")).toBeInTheDocument());
  expect(screen.queryByText(/connected as/i)).toBeNull();
});

test("AWS shows a region dropdown then lists with the chosen region", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "arn:aws:iam::1:user/jane" }),
    paramOptions: vi.fn().mockResolvedValue({ options: ["us-east-1", "eu-west-1"], default: "eu-west-1" }),
    list: vi.fn().mockResolvedValue({ clusters: [{ id: "prod", name: "prod", region: "eu-west-1" }] }),
    connect: vi.fn().mockResolvedValue({ context: "ctx", backupPath: null }),
  };
  wrap(<ConnectWizard descriptor={awsDesc} actions={actions} onConnected={vi.fn()} />);

  const select = await screen.findByLabelText(/region/i);
  expect((select as HTMLSelectElement).value).toBe("eu-west-1");
  fireEvent.change(select, { target: { value: "us-east-1" } });
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));

  await waitFor(() => expect(actions.list).toHaveBeenCalledWith("aws", { region: "us-east-1" }));
  await waitFor(() => expect(screen.getByText("prod")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /connect prod/i }));
  await waitFor(() => expect(actions.connect).toHaveBeenCalledWith("aws", { id: "prod", name: "prod", region: "eu-west-1" }, { region: "us-east-1" }));
});

test("AWS dropdown prepends a CLI default that isn't in the option list", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "arn:aws:iam::1:user/jane" }),
    paramOptions: vi.fn().mockResolvedValue({ options: ["us-east-1", "eu-west-1"], default: "ap-south-1" }),
    list: vi.fn().mockResolvedValue({ clusters: [] }),
    connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={awsDesc} actions={actions} onConnected={vi.fn()} />);
  const select = await screen.findByLabelText(/region/i);
  expect((select as HTMLSelectElement).value).toBe("ap-south-1");
  expect(screen.getByRole("option", { name: "ap-south-1" })).toBeInTheDocument();
});

test("GCP shows the extra-binary install panel when the plugin is missing", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: false, authenticated: false }),
    paramOptions: vi.fn(), list: vi.fn(), connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={gcpDesc} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/^install gke-gcloud-auth-plugin$/i)).toBeInTheDocument());
  expect(screen.getByText("gcloud components install gke-gcloud-auth-plugin")).toBeInTheDocument();
});

test("GCP shows a project dropdown then lists + connects with the chosen project", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "jane@example.com" }),
    paramOptions: vi.fn().mockResolvedValue({ options: ["proj-a", "proj-b"], default: "proj-a" }),
    list: vi.fn().mockResolvedValue({ clusters: [{ id: "prod", name: "prod", region: "us-central1", location: "us-central1" }] }),
    connect: vi.fn().mockResolvedValue({ context: "ctx", backupPath: null }),
  };
  wrap(<ConnectWizard descriptor={gcpDesc} actions={actions} onConnected={vi.fn()} />);
  const select = await screen.findByLabelText(/project/i);
  expect((select as HTMLSelectElement).value).toBe("proj-a");
  fireEvent.change(select, { target: { value: "proj-b" } });
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
  await waitFor(() => expect(actions.list).toHaveBeenCalledWith("gcp", { project: "proj-b" }));
  await waitFor(() => expect(screen.getByText("prod")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /connect prod/i }));
  await waitFor(() => expect(actions.connect).toHaveBeenCalledWith("gcp", { id: "prod", name: "prod", region: "us-central1", location: "us-central1" }, { project: "proj-b" }));
});

test("ErrorPanel shows guidance for a recognized AWS access-denied error and hides raw details until expanded", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "arn:aws:iam::1:user/Admin" }),
    paramOptions: vi.fn().mockResolvedValue({ options: ["us-east-1"], default: "us-east-1" }),
    list: vi.fn().mockResolvedValue({ error: "AccessDenied", stderr: "User: arn:aws:iam::1:user/Admin is not authorized to perform: eks:ListClusters" }),
    connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={awsDesc} actions={actions} onConnected={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /continue/i }));
  await waitFor(() => expect(screen.getByText("Your AWS identity can't access EKS")).toBeInTheDocument());
  expect(screen.getByText(/AmazonEKSClusterPolicy/)).toBeInTheDocument();
  expect(screen.getByText(/signed in as/i)).toBeInTheDocument();
  expect(screen.getByText("arn:aws:iam::1:user/Admin")).toBeInTheDocument();
  expect(screen.queryByText(/not authorized to perform/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /error details/i }));
  expect(screen.getByText(/not authorized to perform/)).toBeInTheDocument();
});

test("ErrorPanel shows the raw error and a generic title for an unrecognized error, and omits the identity line when there's no account", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true }),
    paramOptions: vi.fn().mockResolvedValue({ options: ["us-east-1"], default: "us-east-1" }),
    list: vi.fn().mockResolvedValue({ error: "boom", stderr: "totally unexpected wibble" }),
    connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={awsDesc} actions={actions} onConnected={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /continue/i }));
  await waitFor(() => expect(screen.getByText(/Couldn't reach Amazon EKS/i)).toBeInTheDocument());
  expect(screen.getByText(/totally unexpected wibble/)).toBeInTheDocument();
  expect(screen.queryByText(/signed in as/i)).toBeNull();
});

test("ErrorPanel Try again re-runs the check", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "arn:x" }),
    paramOptions: vi.fn().mockResolvedValue({ options: ["us-east-1"], default: "us-east-1" }),
    list: vi.fn().mockResolvedValue({ error: "boom", stderr: "nope" }),
    connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={awsDesc} actions={actions} onConnected={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /continue/i }));
  await waitFor(() => expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /try again/i }));
  await waitFor(() => expect(actions.check).toHaveBeenCalledTimes(2));
});
