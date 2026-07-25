// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const tools = { dockerRunning: true, kind: true, k3d: false, os: "mac" as const, installer: null };
vi.mock("@/lib/api", () => ({
  useClusterTools: () => ({ data: tools, refetch: vi.fn(), isFetching: false }),
}));
vi.mock("@/lib/ws", () => ({
  sendClusterCreate: vi.fn(),
  onClusterEvent: () => () => {},
}));

import { CreateClusterBody, clusterToolsReady } from "./CreateClusterBody";
import { WizardHostContext } from "./onboarding/wizardHost";

function wrap(host?: { actionSlot: HTMLElement | null }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const body = (
    <QueryClientProvider client={qc}>
      <CreateClusterBody active onDone={vi.fn()} />
    </QueryClientProvider>
  );
  return render(
    host ? (
      <WizardHostContext.Provider value={{ actionSlot: host.actionSlot, setSubflow: vi.fn() }}>
        {body}
      </WizardHostContext.Provider>
    ) : (
      body
    ),
  );
}

beforeEach(() => {
  Object.assign(tools, { dockerRunning: true, kind: true, k3d: false, os: "mac" as const });
});

describe("CreateClusterBody tool choice", () => {
  // The old rule was "only show Tool when BOTH are installed", which meant the
  // common case (one installed) showed no tool row at all: the form looked like
  // it was missing an option and never said which tool was about to run.
  it("lists both tools even when only one is installed", () => {
    wrap();
    expect(screen.getByRole("button", { name: /kind/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /k3d/i })).toBeInTheDocument();
  });

  it("says which tool was found and which was not", () => {
    wrap();
    expect(screen.getByRole("button", { name: /kind/i })).toHaveTextContent("detected");
    expect(screen.getByRole("button", { name: /k3d/i })).toHaveTextContent("not installed");
  });

  it("lets the user pick a tool that is not installed", () => {
    wrap();
    expect(screen.getByRole("button", { name: /k3d/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /kind/i })).toBeEnabled();
  });
});

// Picking a tool you do not have is how you ask how to get it, so readiness
// follows the SELECTED tool rather than "any tool is installed".
describe("CreateClusterBody install instructions", () => {
  it("swaps the form for install instructions when the picked tool is missing", () => {
    wrap();
    expect(screen.getByLabelText(/cluster name/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /k3d/i }));

    expect(screen.getByText("Install k3d on macOS")).toBeInTheDocument();
    expect(screen.getByText("brew install k3d")).toBeInTheDocument();
    expect(screen.getByText("k3d is not installed")).toBeInTheDocument();
    // Nothing to name or version until the tool exists.
    expect(screen.queryByLabelText(/cluster name/i)).not.toBeInTheDocument();
  });

  it("names the command for the platform Rigel is running on", () => {
    Object.assign(tools, { os: "windows" as const });
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /k3d/i }));
    expect(screen.getByText("Install k3d on Windows")).toBeInTheDocument();
    expect(screen.getByText("choco install k3d")).toBeInTheDocument();
  });

  it("offers Re-check, not Create, while the picked tool is missing", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    wrap({ actionSlot: slot });
    expect(slot).toHaveTextContent("Create cluster");

    fireEvent.click(screen.getByRole("button", { name: /k3d/i }));
    expect(slot).toHaveTextContent("Re-check");
    expect(slot).not.toHaveTextContent("Create cluster");
  });

  it("goes back to the form when the user picks the installed tool again", () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /k3d/i }));
    fireEvent.click(screen.getByRole("button", { name: /kind/i }));
    expect(screen.getByLabelText(/cluster name/i)).toBeInTheDocument();
    expect(screen.queryByText(/Install k3d/)).not.toBeInTheDocument();
  });

  it("links the picked tool's own docs, not the other tool's", () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /k3d/i }));
    const link = screen.getByRole("link", { name: /other ways to install k3d/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("k3d.io"));
  });
});

// Docker down is a different failure from a missing tool: the tool picker is
// fine, so the panel says how to start Docker on this platform instead.
describe("CreateClusterBody Docker not running", () => {
  beforeEach(() => {
    Object.assign(tools, { dockerRunning: false, kind: true, k3d: false });
  });

  it("says how to start Docker on this platform, and keeps the tool row intact", () => {
    wrap();
    expect(screen.getByText("Start Docker Desktop on macOS")).toBeInTheDocument();
    expect(screen.getByText("open -a Docker")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /get docker desktop/i })).toBeInTheDocument();
    expect(screen.getByText("Docker is not running")).toBeInTheDocument();
    expect(screen.getByText("kind is installed")).toBeInTheDocument();
    // The tool is not the problem, so no install instructions for it.
    expect(screen.queryByText(/^Install kind on/)).not.toBeInTheDocument();
  });

  it("uses systemd on Linux", () => {
    Object.assign(tools, { os: "linux" as const });
    wrap();
    expect(screen.getByText("Start Docker Desktop on Linux")).toBeInTheDocument();
    expect(screen.getByText("sudo systemctl start docker")).toBeInTheDocument();
  });

  // Launching Docker Desktop on Windows means an exe whose path varies by
  // install, so a wrong path would be worse than a sentence.
  it("gives Windows a written step instead of a command to copy", () => {
    Object.assign(tools, { os: "windows" as const });
    wrap();
    expect(screen.getByText(/Start Docker Desktop from the Start menu/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^copy$/i })).not.toBeInTheDocument();
  });

  it("shows both remedies when the tool is missing too", () => {
    Object.assign(tools, { kind: false });
    wrap();
    expect(screen.getByText("Install kind on macOS")).toBeInTheDocument();
    expect(screen.getByText("Start Docker Desktop on macOS")).toBeInTheDocument();
    expect(screen.getByText("kind is not installed")).toBeInTheDocument();
    expect(screen.getByText("Docker is not running")).toBeInTheDocument();
  });

  // Two command boxes are on screen at once here, so a shared "copied" flag
  // would make both claim to have been copied.
  it("confirms only the command that was copied", () => {
    Object.assign(tools, { kind: false });
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    wrap();
    const [toolCopy] = screen.getAllByRole("button", { name: /^copy$/i });
    fireEvent.click(toolCopy);

    expect(screen.getAllByRole("button", { name: /copied/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^copy$/i })).toHaveLength(1);
  });
});

describe("CreateClusterBody hosting", () => {
  it("keeps its own intro and button row outside the wizard", () => {
    wrap();
    expect(screen.getByText(/run the cluster as Docker containers/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create cluster$/i })).toBeInTheDocument();
  });

  it("gives up its intro and Cancel to the wizard, and puts Create in the host slot", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    wrap({ actionSlot: slot });

    expect(screen.queryByText(/run the cluster as Docker containers/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(slot).toHaveTextContent("Create cluster");
  });

  it("offers Re-check instead of Create while the machine is not ready", () => {
    Object.assign(tools, { dockerRunning: false });
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    wrap({ actionSlot: slot });

    expect(slot).toHaveTextContent("Re-check");
    expect(slot).not.toHaveTextContent("Create cluster");
    expect(screen.getByText("Docker is not running")).toBeInTheDocument();
    expect(screen.getByText(/Start Docker, then re-check/)).toBeInTheDocument();
  });
});

describe("clusterToolsReady", () => {
  it("needs Docker up and at least one tool", () => {
    expect(clusterToolsReady({ ...tools, dockerRunning: true, kind: true, k3d: false })).toBe(true);
    expect(clusterToolsReady({ ...tools, dockerRunning: true, kind: false, k3d: true })).toBe(true);
    expect(clusterToolsReady({ ...tools, dockerRunning: false, kind: true, k3d: true })).toBe(false);
    expect(clusterToolsReady({ ...tools, dockerRunning: true, kind: false, k3d: false })).toBe(false);
    expect(clusterToolsReady(undefined)).toBe(false);
  });
});
