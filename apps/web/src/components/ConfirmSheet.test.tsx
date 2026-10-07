// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Override only fetchPreviewCommand so the Execute button enables; keep the rest
// of the api module real (useAction, etc.).
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchPreviewCommand: vi.fn(async () => ["kubectl", "drain", "k8s-truenas"]) };
});

// Spy on the background runner.
const runActionInBackground = vi.fn();
vi.mock("@/lib/actionRunner", () => ({
  runActionInBackground: (...a: unknown[]) => runActionInBackground(...a),
}));

let mockActiveContext: string | null = null;
vi.mock("@/store/cluster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/cluster")>();
  return {
    ...actual,
    useCluster: Object.assign(
      (selector: (s: { activeContext: string | null }) => unknown) => selector({ activeContext: mockActiveContext }),
      { getState: () => ({ activeContext: mockActiveContext }) },
    ),
  };
});

import { ConfirmSheet } from "./ConfirmSheet";
import type { ActionBlock } from "@/lib/api";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  runActionInBackground.mockClear();
  mockActiveContext = null;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ purge: true, name: null, namespace: "default" }) })));
});

describe("ConfirmSheet — non-blocking execute", () => {
  it("closes the modal immediately and runs the action in the background", async () => {
    const onClose = vi.fn();
    const drain: ActionBlock = { kind: "drain", node: "k8s-truenas", label: "Drain node k8s-truenas" };

    wrap(<ConfirmSheet action={drain} open={true} onClose={onClose} />);

    // Wait for the preview command to load so Execute enables.
    const execute = await screen.findByRole("button", { name: /execute/i });
    await waitFor(() => expect(execute).not.toBeDisabled());

    await userEvent.click(execute);

    // The modal closes right away — it does NOT stay open in a "Running…" state.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(runActionInBackground).toHaveBeenCalledTimes(1);
    expect(runActionInBackground.mock.calls[0]?.[0]).toMatchObject({
      action: drain,
      label: "Drain node k8s-truenas",
      commandString: "kubectl drain k8s-truenas",
    });
  });

  it("keeps purge in-modal (does not background-run it)", async () => {
    const onClose = vi.fn();
    const onPurge = vi.fn();
    const purge: ActionBlock = { kind: "purge", name: "affine", namespace: "default", label: "Remove affine" };

    wrap(<ConfirmSheet action={purge} open={true} onClose={onClose} onPurge={onPurge} />);

    const cont = await screen.findByRole("button", { name: /continue to removal/i });
    await userEvent.click(cont);

    expect(runActionInBackground).not.toHaveBeenCalled();
  });
});

describe("ConfirmSheet — target cluster indicator", () => {
  it("shows the active context above the command preview", async () => {
    mockActiveContext = "k8s-truenas";
    const purge: ActionBlock = { kind: "purge", name: "affine", namespace: "default", label: "Remove affine" };

    wrap(<ConfirmSheet action={purge} open={true} onClose={vi.fn()} onPurge={vi.fn()} />);

    expect(await screen.findByText("Runs on")).toBeInTheDocument();
    expect(await screen.findByText("k8s-truenas")).toBeInTheDocument();
  });

  it("renders no target cluster row when there is no active context", async () => {
    mockActiveContext = null;
    const purge: ActionBlock = { kind: "purge", name: "affine", namespace: "default", label: "Remove affine" };

    wrap(<ConfirmSheet action={purge} open={true} onClose={vi.fn()} onPurge={vi.fn()} />);

    await screen.findByRole("button", { name: /continue to removal/i });
    expect(screen.queryByText("Runs on")).not.toBeInTheDocument();
  });
});

describe("ConfirmSheet — sshCommand", () => {
  it("shows the host and the exact ssh command instead of the cluster target", async () => {
    mockActiveContext = "k8s-truenas";
    const { fetchPreviewCommand } = await import("@/lib/api");
    vi.mocked(fetchPreviewCommand).mockResolvedValueOnce([
      "ssh", "-T", "-o", "BatchMode=yes", "--", "web-1", "sudo systemctl restart k3s",
    ]);
    const ssh: ActionBlock = { kind: "sshCommand", host: "web-1", command: "sudo systemctl restart k3s" };

    wrap(<ConfirmSheet action={ssh} open={true} onClose={vi.fn()} />);

    expect(await screen.findByText("Run on web-1")).toBeInTheDocument();
    const preview = await screen.findByText(
      (_, el) => el?.tagName === "PRE" && !!el.textContent?.includes("ssh -T -o BatchMode=yes -- web-1 sudo systemctl restart k3s"),
    );
    expect(preview).toBeInTheDocument();
    expect(screen.getByText(/will run on web-1/)).toBeInTheDocument();
    expect(screen.queryByText("Runs on")).not.toBeInTheDocument();
  });
});

describe("ConfirmSheet — sshCommand risk pill", () => {
  it("labels a host command Remote, never Safe", async () => {
    const ssh: ActionBlock = { kind: "sshCommand", host: "web-1", command: "sudo systemctl restart k3s" };
    wrap(<ConfirmSheet action={ssh} open={true} onClose={vi.fn()} />);
    expect(await screen.findByText("Remote")).toBeInTheDocument();
    expect(screen.queryByText("Safe")).not.toBeInTheDocument();
  });

  it("labels a destructive host command Destructive", async () => {
    const ssh: ActionBlock = { kind: "sshCommand", host: "web-1", command: "rm -rf /var/lib/old", destructive: true };
    wrap(<ConfirmSheet action={ssh} open={true} onClose={vi.fn()} />);
    expect(await screen.findByText("Destructive")).toBeInTheDocument();
    expect(screen.queryByText("Remote")).not.toBeInTheDocument();
  });
});

describe("ConfirmSheet — sudo sshCommand", () => {
  const sudo: ActionBlock = {
    kind: "sshCommand",
    label: "Upgrade packages",
    host: "web-1",
    command: "apt-get upgrade -y",
    sudo: true,
  };
  const wrapped = "sh -c 'sudo -S -p ... -v && ... && sudo -n -- sh -c apt-get upgrade -y'";

  beforeEach(async () => {
    const { fetchPreviewCommand } = await import("@/lib/api");
    vi.mocked(fetchPreviewCommand).mockResolvedValue(["ssh", "-T", "-o", "BatchMode=yes", "--", "web-1", wrapped]);
  });

  async function runAsRoot() {
    const button = await screen.findByRole("button", { name: /run as root/i });
    await waitFor(() => expect(screen.getByText((_, el) => el?.tagName === "PRE" && !!el.textContent?.includes(wrapped))).toBeInTheDocument());
    return button;
  }

  const field = () => screen.getByLabelText("Sudo password for web-1");

  it("shows the sudo treatment: pill, target host, and a focused password field with its hint", async () => {
    wrap(<ConfirmSheet action={sudo} open={true} onClose={vi.fn()} fromChat />);
    await runAsRoot();

    expect(screen.getByText("Needs sudo").getAttribute("style")).toContain("var(--accent-sudo)");
    expect(screen.queryByText("Remote")).not.toBeInTheDocument();
    expect(screen.getByText("Runs on")).toBeInTheDocument();
    expect(field()).toHaveAttribute("type", "password");
    expect(field()).toHaveFocus();
    expect(
      screen.getByText(
        "Sent once over the encrypted SSH connection. Not stored, logged, or shown to the assistant. Leave empty if sudo doesn't ask for a password on this host.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the field out of autofill, spellcheck and autocorrect", async () => {
    wrap(<ConfirmSheet action={sudo} open={true} onClose={vi.fn()} fromChat />);
    await runAsRoot();

    expect(field()).toHaveAttribute("autocomplete", "new-password");
    expect(field()).toHaveAttribute("spellcheck", "false");
    expect(field()).toHaveAttribute("autocapitalize", "none");
    expect(field()).toHaveAttribute("autocorrect", "off");
  });

  it("names the ssh user in the target when the host's config is known", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ hosts: [{ alias: "web-1", hostName: "10.0.0.5", user: "tyrel", port: "22", enabled: true }] }),
    })));
    wrap(<ConfirmSheet action={sudo} open={true} onClose={vi.fn()} fromChat />);

    expect(await screen.findByText("tyrel@web-1")).toBeInTheDocument();
  });

  it("runs with no password for a host where sudo doesn't ask for one", async () => {
    wrap(<ConfirmSheet action={sudo} open={true} onClose={vi.fn()} fromChat />);
    const button = await runAsRoot();
    await waitFor(() => expect(button).not.toBeDisabled());
    await userEvent.click(button);

    expect(runActionInBackground).toHaveBeenCalledTimes(1);
    expect((runActionInBackground.mock.calls[0]![0] as { secret?: string }).secret).toBeUndefined();
  });

  it("hands the password to the runner beside the action and clears the field", async () => {
    const onClose = vi.fn();
    wrap(<ConfirmSheet action={sudo} open={true} onClose={onClose} fromChat />);
    const button = await runAsRoot();
    await userEvent.type(field(), "hunter2");
    await userEvent.click(button);

    expect(runActionInBackground).toHaveBeenCalledTimes(1);
    const opts = runActionInBackground.mock.calls[0]![0] as { action: ActionBlock; secret?: string; commandString: string };
    expect(opts.secret).toBe("hunter2");
    expect(opts.action).toBe(sudo);
    expect(JSON.stringify(opts.action)).not.toContain("hunter2");
    expect(opts.commandString).not.toContain("hunter2");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue("");
  });

  it("submits when Enter is pressed in the password field, empty or not", async () => {
    wrap(<ConfirmSheet action={sudo} open={true} onClose={vi.fn()} fromChat />);
    await runAsRoot();
    await userEvent.type(field(), "hunter2{Enter}");
    await userEvent.type(field(), "{Enter}");

    expect(runActionInBackground).toHaveBeenCalledTimes(2);
    expect((runActionInBackground.mock.calls[0]![0] as { secret?: string }).secret).toBe("hunter2");
    expect((runActionInBackground.mock.calls[1]![0] as { secret?: string }).secret).toBeUndefined();
  });

  it("clears the password on cancel", async () => {
    wrap(<ConfirmSheet action={sudo} open={true} onClose={vi.fn()} fromChat />);
    await runAsRoot();
    await userEvent.type(field(), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(field()).toHaveValue("");
    expect(runActionInBackground).not.toHaveBeenCalled();
  });

  it("clears the password when the action changes while the dialog stays open", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (action: ActionBlock) => (
      <QueryClientProvider client={qc}>
        <ConfirmSheet action={action} open={true} onClose={vi.fn()} fromChat />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(sudo));
    await runAsRoot();
    await userEvent.type(field(), "hunter2");

    rerender(ui({ ...sudo, label: "Upgrade packages again" }));
    await waitFor(() => expect(field()).toHaveValue(""));
  });

  it("asks for no password on a plain ssh action", async () => {
    const { fetchPreviewCommand } = await import("@/lib/api");
    vi.mocked(fetchPreviewCommand).mockResolvedValue(["ssh", "-T", "-o", "BatchMode=yes", "--", "web-1", "uptime"]);
    wrap(<ConfirmSheet action={{ kind: "sshCommand", host: "web-1", command: "uptime" }} open={true} onClose={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /execute/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/sudo password/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Needs sudo")).not.toBeInTheDocument();
  });
});
