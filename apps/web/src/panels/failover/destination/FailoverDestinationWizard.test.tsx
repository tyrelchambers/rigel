// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverDestinationWizard } from "./FailoverDestinationWizard";

const save = vi.fn();
const validate = vi.fn();

vi.mock("@/lib/api", () => ({
  useSaveFailoverConfig: () => ({ mutate: save, isPending: false, error: null }),
  validateFailoverDestination: (patch: unknown) => validate(patch),
  cloudCheck: async () => ({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true }),
}));

const cluster = { context: "home", namespace: "rigel", secret: "rigel-user-config", state: "ok" as const };

const okToken = {
  ok: true,
  api: { ok: true, email: "me@example.com" },
  options: {
    regions: [{ slug: "tor1", name: "Toronto 1" }],
    sizes: [{ slug: "s-4vcpu-8gb", name: "4 vCPU / 8 GB" }],
  },
};

function open() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FailoverDestinationWizard open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function toCredentials() {
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
  await screen.findByText(/connect to digitalocean/i);
}

beforeEach(() => {
  save.mockClear();
  validate.mockReset().mockResolvedValue(okToken);
});

describe("step 1, the chooser", () => {
  it("offers one provider that works and one that does not", () => {
    open();
    expect(screen.getByText("DigitalOcean")).toBeInTheDocument();
    expect(screen.getByText("AWS")).toBeInTheDocument();
    expect(screen.getByText("COMING SOON")).toBeInTheDocument();
    expect(screen.getByText("AWS").closest("button")).toBeDisabled();
  });
});

describe("step 2, credentials", () => {
  it("will not continue until the token is validated", async () => {
    open();
    await toCredentials();
    expect(screen.getByRole("button", { name: /validate/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "dop_v1_abc" } });
    expect(screen.getByRole("button", { name: /validate/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText(/signed in as me@example\.com/i);
    expect(screen.getByRole("button", { name: /continue/i })).toBeInTheDocument();
  });

  it("shows the token error and stays put", async () => {
    validate.mockResolvedValue({
      ok: false,
      api: { ok: false, status: 401, error: "DigitalOcean rejected this token." },
    });
    open();
    await toCredentials();
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText(/rejected this token/i);
    expect(screen.queryByRole("button", { name: /continue/i })).not.toBeInTheDocument();
  });

  it("makes an edited token unvalidated again", async () => {
    open();
    await toCredentials();
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "dop_v1_abc" } });
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText(/signed in as/i);
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "dop_v1_changed" } });
    expect(screen.getByRole("button", { name: /validate/i })).toBeInTheDocument();
  });
});

describe("step 3, the object store", () => {
  async function toStore() {
    open();
    await toCredentials();
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "dop_v1_abc" } });
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText(/signed in as/i);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/an off-site copy of the dumps/i);
  }

  it("starts skipped, and says what skipping costs", async () => {
    await toStore();
    expect(screen.getByText(/holds the only copy of your data/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("suggests the addressing style from the endpoint, and lets it be overridden", async () => {
    await toStore();
    fireEvent.click(screen.getByRole("button", { name: /add an object store/i }));
    fireEvent.change(screen.getByLabelText("Endpoint"), {
      target: { value: "https://tor1.digitaloceanspaces.com" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "bucket.host" })).toHaveStyle({ color: "#FFFFFF" }));

    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "https://garage.internal:3900" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "host/bucket" })).toHaveStyle({ color: "#FFFFFF" }));

    fireEvent.click(screen.getByRole("button", { name: "bucket.host" }));
    expect(screen.getByRole("button", { name: "bucket.host" })).toHaveStyle({ color: "#FFFFFF" });
  });

  it("warns without blocking when the store is inside the source cluster", async () => {
    validate.mockResolvedValue({
      ...okToken,
      objectStore: { ok: true, bucketExists: true, insideSourceCluster: true },
    });
    await toStore();
    fireEvent.click(screen.getByRole("button", { name: /add an object store/i }));
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "https://garage.default.svc.cluster.local:3900" } });
    fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText(/goes down with the building/i);
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("says a missing bucket will be created", async () => {
    validate.mockResolvedValue({
      ...okToken,
      objectStore: { ok: true, bucketExists: false, insideSourceCluster: false },
    });
    await toStore();
    fireEvent.click(screen.getByRole("button", { name: /add an object store/i }));
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "https://s3.example.net" } });
    fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText(/will be created when you save/i);
  });

  it("shows an addressing failure with the fix", async () => {
    validate.mockResolvedValue({
      ok: false,
      api: { ok: true, email: "me@example.com" },
      objectStore: { ok: false, code: "addressing", error: "Nothing answers at b.s3.example.net. Switch to host/bucket addressing and validate again." },
    });
    await toStore();
    fireEvent.click(screen.getByRole("button", { name: /add an object store/i }));
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "https://s3.example.net" } });
    fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText(/switch to host\/bucket addressing/i);
  });
});

describe("the whole way through", () => {
  it("saves a destination with no object store and no edge", async () => {
    open();
    await toCredentials();
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "dop_v1_abc" } });
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText(/signed in as/i);

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/an off-site copy of the dumps/i);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await screen.findByText(/how big should the copy be/i);
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "tor1" } });
    fireEvent.change(screen.getByLabelText("Node size"), { target: { value: "s-4vcpu-8gb" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await screen.findByText(/what sits in front of your cluster/i);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await screen.findByText(/save this destination/i);
    fireEvent.click(screen.getByRole("button", { name: /save destination/i }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ token: "dop_v1_abc", region: "tor1", nodeSize: "s-4vcpu-8gb" }),
      expect.anything(),
    );
    expect(save.mock.calls[0]![0]).not.toHaveProperty("objectStore");
    expect(save.mock.calls[0]![0]).not.toHaveProperty("edge");
  });

  it("rejects an edge host with no backend lines", async () => {
    open();
    await toCredentials();
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "t" } });
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText(/signed in as/i);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/an off-site copy/i);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/how big should the copy be/i);
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "tor1" } });
    fireEvent.change(screen.getByLabelText("Node size"), { target: { value: "s-4vcpu-8gb" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/what sits in front/i);

    fireEvent.change(screen.getByLabelText("Edge host"), { target: { value: "203.0.113.9" } });
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Backend servers"), { target: { value: "node1 10.0.0.1" } });
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });
});

describe("editing an existing destination", () => {
  const view = {
    configured: true,
    provider: "digitalocean" as const,
    tokenSet: true,
    region: "tor1",
    nodeSize: "s-4vcpu-8gb",
    nodeCount: 1,
    cluster,
  };

  it("omits an untouched token so the stored one survives", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FailoverDestinationWizard open onOpenChange={vi.fn()} view={view} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/connect to digitalocean/i);
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText(/signed in as/i);
    expect(validate).toHaveBeenCalledWith(expect.not.objectContaining({ token: expect.anything() }));
  });
});
