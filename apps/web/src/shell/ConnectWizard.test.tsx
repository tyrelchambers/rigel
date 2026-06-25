// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectWizard } from "./ConnectWizard";
import { descriptorFor } from "@rigel/cloud-connect/src/index";

const doDesc = descriptorFor("digitalocean")!;
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

test("shows install help when the CLI is missing", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: false, extraBinariesInstalled: true, authenticated: false }),
    list: vi.fn(), connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/brew install doctl/i)).toBeInTheDocument());
});

test("install panel shows all three platform commands", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: false, extraBinariesInstalled: true, authenticated: false }),
    list: vi.fn(), connect: vi.fn(),
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
    list: vi.fn(), connect: vi.fn(),
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
    list: vi.fn(), connect: vi.fn(),
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
    list: vi.fn(), connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/doctl auth init/i)).toBeInTheDocument());
});

test("lists clusters and connects the chosen one", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "me@example.com" }),
    list: vi.fn().mockResolvedValue({ clusters: [{ id: "abc", name: "prod", region: "nyc1" }] }),
    connect: vi.fn().mockResolvedValue({ context: "do-nyc1-prod", backupPath: null }),
  };
  const onConnected = vi.fn();
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={onConnected} />);

  await waitFor(() => expect(screen.getByText("prod")).toBeInTheDocument());
  expect(screen.getByText(/connected as me@example\.com/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /connect prod/i }));
  await waitFor(() => expect(actions.connect).toHaveBeenCalledWith("digitalocean", { id: "abc", name: "prod", region: "nyc1" }));
  await waitFor(() => expect(onConnected).toHaveBeenCalledWith("do-nyc1-prod"));
});

test("shows self-explaining empty state with account when no clusters", async () => {
  const actions = {
    check: vi.fn().mockResolvedValue({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true, account: "me@example.com" }),
    list: vi.fn().mockResolvedValue({ clusters: [] }),
    connect: vi.fn(),
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
    connect: vi.fn(),
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
    connect: vi.fn(),
  };
  wrap(<ConnectWizard descriptor={doDesc} actions={actions} onConnected={vi.fn()} />);

  await waitFor(() => expect(screen.getByText("prod")).toBeInTheDocument());
  expect(screen.queryByText(/connected as/i)).toBeNull();
});
