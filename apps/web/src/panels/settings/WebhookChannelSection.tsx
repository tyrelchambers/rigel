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
import { ChannelGlyph, CHANNEL_GLYPH_COLORS } from "./channelGlyphs";

type WebhookChannelId = "discord" | "slack";

const BRAND: Record<WebhookChannelId, { color: string; icon: React.ReactNode; placeholder: string }> = {
  discord: { color: CHANNEL_GLYPH_COLORS.discord, icon: <ChannelGlyph id="discord" />, placeholder: "https://…/webhooks/…" },
  slack: { color: CHANNEL_GLYPH_COLORS.slack, icon: <ChannelGlyph id="slack" />, placeholder: "https://…/services/…" },
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
