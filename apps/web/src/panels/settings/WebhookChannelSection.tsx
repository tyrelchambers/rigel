// Webhook-backed channel card (Discord/Slack) — one component, parameterized
// by channelId, styled to match MatrixSection/SignalSection. Connect/disconnect
// + the URL edit + "Send test" all go through the generic setChannel action
// and the /api/channels test-send proxy (see @rigel/k8s CHANNELS descriptor).

import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faTriangleExclamation,
  faCheck,
  faPlugCircleXmark,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import { useAssistantAction, useChannelTest } from "@/lib/api";
import { CHANNELS } from "@rigel/k8s";
import type { SettingsDerived } from "./useSettings";
import { NotifyToggle } from "./NotifyToggle";
import { ChannelDisconnectDialog } from "./ChannelDisconnectDialog";

type WebhookChannelId = "discord" | "slack";

function DiscordMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.522 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286ZM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189Zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

function SlackMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="currentColor" aria-hidden="true">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

const BRAND: Record<WebhookChannelId, { color: string; icon: React.ReactNode; placeholder: string }> = {
  discord: { color: "#5865F2", icon: <DiscordMark />, placeholder: "https://…/webhooks/…" },
  slack: { color: "#36C5F0", icon: <SlackMark />, placeholder: "https://…/services/…" },
};

export function WebhookChannelSection({
  channelId,
  label,
  derived,
}: {
  channelId: WebhookChannelId;
  label: string;
  derived: SettingsDerived;
}) {
  const { namespace, notifyChannels } = derived;
  const savedUrl = derived.webhookUrls[channelId] ?? "";
  const connected = derived.connectedChannels.includes(channelId);
  const brand = BRAND[channelId];
  const configKey = CHANNELS[channelId].configKeys[0];

  const setChannel = useAssistantAction();
  const testChannel = useChannelTest();

  const [urlText, setUrlText] = useState(savedUrl);
  useEffect(() => setUrlText(savedUrl), [savedUrl]);

  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  async function save() {
    setError(null);
    setTestResult(null);
    const trimmed = urlText.trim();
    if (trimmed === "") {
      setError("Paste a webhook URL first.");
      return;
    }
    try {
      await setChannel.mutateAsync({
        action: "setChannel",
        namespace,
        channel: channelId,
        channelData: { [configKey]: trimmed },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function sendTest() {
    setError(null);
    setTestResult(null);
    const trimmed = urlText.trim();
    if (trimmed === "") {
      setError("Paste a webhook URL first.");
      return;
    }
    try {
      await testChannel.mutateAsync({ channel: channelId, url: trimmed });
      setTestResult("Sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function disconnect() {
    setDisconnectError(null);
    try {
      await setChannel.mutateAsync({
        action: "setChannel",
        namespace,
        channel: channelId,
        channelData: CHANNELS[channelId].disconnectUpdates(),
      });
      setDisconnectOpen(false);
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-[14px] border border-[var(--border-subtle)] bg-card p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="flex size-9 items-center justify-center rounded-lg"
            style={{ background: `color-mix(in oklab, ${brand.color} 16%, transparent)`, color: brand.color }}
          >
            {brand.icon}
          </div>
          <div className="flex flex-col gap-[3px]">
            <span className="text-sm font-semibold text-foreground">{label}</span>
            <div className="flex items-center gap-[7px]">
              <span
                className="inline-block size-1.5 rounded-full"
                style={{ background: connected ? "var(--status-running)" : "var(--fg-tertiary)" }}
              />
              <span className="text-xs text-muted-foreground">
                {connected ? "Connected" : "Not connected"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <NotifyToggle channelId={channelId} namespace={namespace} enabled={notifyChannels.includes(channelId)} />
          {connected && (
            <button
              type="button"
              onClick={() => {
                setDisconnectError(null);
                setDisconnectOpen(true);
              }}
              disabled={setChannel.isPending}
              className="flex items-center gap-[7px] transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              <FontAwesomeIcon icon={faPlugCircleXmark} className="size-[14px] text-destructive" />
              <span className="text-xs font-medium text-destructive">Disconnect</span>
            </button>
          )}
        </div>
      </div>

      {!connected && (
        <span className="text-xs text-muted-foreground" style={{ lineHeight: 1.45 }}>
          Paste an incoming webhook URL to send {label} alerts and remediation notifications.
        </span>
      )}

      <div className="h-px w-full bg-[var(--border-subtle)]" />

      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-3xs uppercase tracking-wide text-[var(--fg-tertiary)]">
          Webhook URL
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-foreground outline-none placeholder:text-[var(--fg-tertiary)] focus:border-primary"
            placeholder={brand.placeholder}
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setUrlText(savedUrl);
              setError(null);
              setTestResult(null);
            }}
            disabled={setChannel.isPending || urlText === savedUrl}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={setChannel.isPending}>
            {connected ? "Save" : "Connect"}
          </Button>
          {connected && (
            <Button size="sm" variant="muted" onClick={sendTest} disabled={testChannel.isPending}>
              {testChannel.isPending ? "Sending…" : "Send test"}
            </Button>
          )}
          {testResult && (
            <span className="flex items-center gap-1 text-xs text-[var(--status-running)]">
              <FontAwesomeIcon icon={faCheck} className="h-3.5 w-3.5" /> {testResult}
            </span>
          )}
        </div>
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="select-text">{error}</span>
          </div>
        )}
      </label>

      <ChannelDisconnectDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        onConfirm={disconnect}
        pending={setChannel.isPending}
        error={disconnectError}
        channel={label}
        description={`This removes the ${label} webhook from Rigel's config. Notifications stop immediately. You can reconnect anytime.`}
      />
    </div>
  );
}
