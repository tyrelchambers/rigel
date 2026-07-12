// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import type { SettingsDerived } from "./useSettings";

const mutateAsync = vi.fn(async () => ({ success: true as const, stdout: "", stderr: "" }));
const testMutateAsync = vi.fn(async () => undefined);
vi.mock("@/lib/api", () => ({
  useAssistantAction: () => ({ mutateAsync, isPending: false }),
  useChannelTest: () => ({ mutateAsync: testMutateAsync, isPending: false }),
}));

import { WebhookChannelSection } from "./WebhookChannelSection";

function derived(over: Partial<SettingsDerived> = {}): SettingsDerived {
  return {
    namespace: "default",
    status: "notDeployed",
    signalNumber: "", recipients: "", hasSavedNumber: false,
    matrixStatus: "notConnected", matrixHomeserverUrl: "", matrixUserId: "",
    matrixRoomId: "", matrixAllowedSenders: "",
    webhookUrls: {}, connectedChannels: [],
    notifyChannels: [],
    ...over,
  } as SettingsDerived;
}

beforeEach(() => {
  mutateAsync.mockClear();
  testMutateAsync.mockClear();
});

describe("WebhookChannelSection — not connected", () => {
  it("shows a Not connected status and a Connect action", () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={derived()} />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
  });

  it("does not show Disconnect or Send test when not connected", () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={derived()} />);
    expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send test/i })).not.toBeInTheDocument();
  });

  it("Connect writes setChannel with the right channelData", async () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={derived()} />);
    fireEvent.change(screen.getByPlaceholderText(/https/i), { target: { value: "https://discord.com/api/webhooks/x" } });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setChannel",
        namespace: "default",
        channel: "discord",
        channelData: { discordWebhookUrl: "https://discord.com/api/webhooks/x" },
      }),
    );
  });

  it("Connect for Slack writes the slackWebhookUrl key", async () => {
    render(<WebhookChannelSection channelId="slack" label="Slack" derived={derived()} />);
    fireEvent.change(screen.getByPlaceholderText(/https/i), { target: { value: "https://hooks.slack.com/services/x" } });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setChannel",
        namespace: "default",
        channel: "slack",
        channelData: { slackWebhookUrl: "https://hooks.slack.com/services/x" },
      }),
    );
  });

  it("shows an error instead of calling setChannel when the URL is empty", async () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={derived()} />);
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(await screen.findByText(/paste a webhook url/i)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe("WebhookChannelSection — connected", () => {
  const connected = () =>
    derived({
      webhookUrls: { discord: "https://discord.com/api/webhooks/saved" },
      connectedChannels: ["discord"],
      notifyChannels: ["discord"],
    });

  it("shows Connected status, the saved URL, and Disconnect", () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={connected()} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://discord.com/api/webhooks/saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  it("Save updates the URL via setChannel", async () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={connected()} />);
    const input = screen.getByDisplayValue("https://discord.com/api/webhooks/saved");
    fireEvent.change(input, { target: { value: "https://discord.com/api/webhooks/new" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setChannel",
        namespace: "default",
        channel: "discord",
        channelData: { discordWebhookUrl: "https://discord.com/api/webhooks/new" },
      }),
    );
  });

  it("Send test calls the channels endpoint with the current URL", async () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={connected()} />);
    fireEvent.click(screen.getByRole("button", { name: /send test/i }));
    await waitFor(() =>
      expect(testMutateAsync).toHaveBeenCalledWith({
        channel: "discord",
        url: "https://discord.com/api/webhooks/saved",
      }),
    );
    expect(await screen.findByText("Sent")).toBeInTheDocument();
  });

  it("Disconnect opens a confirm dialog instead of calling setChannel directly", () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={connected()} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).getByText(/disconnect discord/i)).toBeInTheDocument();
  });

  it("confirming Disconnect calls setChannel with the disconnect patch", async () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={connected()} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^disconnect$/i }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setChannel",
        namespace: "default",
        channel: "discord",
        channelData: { discordWebhookUrl: "" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows a Notifications toggle reflecting the effective notify set", () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={connected()} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("toggling Notifications calls setChannel with channelNotify", async () => {
    render(<WebhookChannelSection channelId="discord" label="Discord" derived={connected()} />);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setChannel",
        namespace: "default",
        channel: "discord",
        channelNotify: false,
      }),
    );
  });
});
