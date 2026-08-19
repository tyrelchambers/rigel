// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { VoiceConfigView } from "@/lib/api";

const mutateAsync = vi.fn(async () => view());
let current: VoiceConfigView;

vi.mock("@/lib/api", () => ({
  useVoiceConfig: () => ({ data: current, isLoading: false, error: null }),
  useSaveVoiceConfig: () => ({ mutateAsync, isPending: false }),
}));

import { VoiceSection } from "./VoiceSection";

function view(over: Partial<VoiceConfigView> = {}): VoiceConfigView {
  return {
    url: "wss://project.livekit.cloud",
    apiKey: "APIkey",
    model: "openai/gpt-4.1-mini",
    sttModel: "deepgram/nova-3",
    ttsModel: "cartesia/sonic-2",
    apiSecretSet: true,
    openrouterApiKeySet: false,
    env: {},
    status: { enabled: true, configured: false },
    cluster: {
      context: "prod-cluster",
      namespace: "default",
      secret: "rigel-user-config",
      state: "ok",
    },
    ...over,
  };
}

const save = () => screen.getByRole("button", { name: /save voice settings/i });
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
  mutateAsync.mockClear();
  current = view();
});

describe("VoiceSection", () => {
  it("renders every field seeded from the masked config, with secrets left empty", () => {
    render(<VoiceSection />);
    expect(field(/livekit url/i).value).toBe("wss://project.livekit.cloud");
    expect(field(/livekit api key/i).value).toBe("APIkey");
    expect(field(/^model$/i).value).toBe("openai/gpt-4.1-mini");
    expect(field(/speech to text model/i).value).toBe("deepgram/nova-3");
    expect(field(/text to speech model/i).value).toBe("cartesia/sonic-2");
    expect(field(/livekit api secret/i).value).toBe("");
    expect(field(/openrouter api key/i).value).toBe("");
  });

  it("reports the stored state of each secret without revealing a value", () => {
    render(<VoiceSection />);
    expect(field(/livekit api secret/i).placeholder).toMatch(/set/i);
    expect(field(/openrouter api key/i).placeholder).toMatch(/not set/i);
  });

  it("surfaces the feature flag and whether voice is configured", () => {
    current = view({ status: { enabled: false, configured: false } });
    const { rerender } = render(<VoiceSection />);
    expect(screen.getByText("Voice off")).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();

    current = view({ status: { enabled: true, configured: true } });
    rerender(<VoiceSection />);
    expect(screen.getByText("Voice on")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
  });

  it("saves only the edited fields, so an untouched secret is left alone", async () => {
    render(<VoiceSection />);
    fireEvent.change(field(/livekit url/i), { target: { value: "wss://other.livekit.cloud" } });
    fireEvent.change(field(/openrouter api key/i), { target: { value: "or-new" } });
    fireEvent.click(save());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({
      url: "wss://other.livekit.cloud",
      openrouterApiKey: "or-new",
    });
  });

  it("blanking a text field sends the empty string that clears it", async () => {
    render(<VoiceSection />);
    fireEvent.change(field(/speech to text model/i), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ sttModel: "" }));
  });

  it("Clear this key sends the empty string for a stored secret", async () => {
    render(<VoiceSection />);
    fireEvent.click(screen.getByRole("button", { name: /clear this key/i }));
    expect(screen.getByText(/cleared on save/i)).toBeInTheDocument();
    fireEvent.click(save());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ apiSecret: "" }));
  });

  it("Save is disabled until something changes, and Cancel drops the edits", () => {
    render(<VoiceSection />);
    expect(save()).toBeDisabled();

    fireEvent.change(field(/livekit api key/i), { target: { value: "APIother" } });
    expect(save()).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(field(/livekit api key/i).value).toBe("APIkey");
    expect(save()).toBeDisabled();
  });

  it("retyping the original value is not a change", () => {
    render(<VoiceSection />);
    fireEvent.change(field(/livekit url/i), { target: { value: "wss://x" } });
    fireEvent.change(field(/livekit url/i), { target: { value: "wss://project.livekit.cloud" } });
    expect(save()).toBeDisabled();
  });

  it("names the cluster the settings belong to", () => {
    render(<VoiceSection />);
    expect(screen.getByText("prod-cluster")).toBeInTheDocument();
    expect(screen.getAllByText("rigel-user-config")).not.toHaveLength(0);
  });

  it("with no cluster reachable, says so and locks the form instead of saving nowhere", () => {
    current = view({
      cluster: {
        context: "prod-cluster",
        namespace: "default",
        secret: "rigel-user-config",
        state: "unavailable",
        message: "The connection to the server 127.0.0.1:6443 was refused",
      },
    });
    render(<VoiceSection />);
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
    expect(screen.getByText(/connection to the server/i)).toBeInTheDocument();
    expect(field(/livekit url/i)).toBeDisabled();
    expect(field(/livekit api secret/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /clear this key/i })).toBeNull();

    fireEvent.change(field(/^model$/i), { target: { value: "openai/gpt-4.1" } });
    expect(save()).toBeDisabled();
  });

  it("an env-supplied field is read-only, names its variable, and never enters the patch", async () => {
    current = view({ env: { url: "LIVEKIT_URL", apiSecret: "LIVEKIT_API_SECRET" } });
    render(<VoiceSection />);
    expect(field(/livekit url/i)).toBeDisabled();
    expect(field(/livekit api secret/i)).toBeDisabled();
    expect(screen.getAllByText("LIVEKIT_URL")).not.toHaveLength(0);
    expect(screen.getAllByText("LIVEKIT_API_SECRET")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: /clear this key/i })).toBeNull();

    fireEvent.change(field(/^model$/i), { target: { value: "openai/gpt-4.1" } });
    fireEvent.click(save());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ model: "openai/gpt-4.1" }));
  });
});
