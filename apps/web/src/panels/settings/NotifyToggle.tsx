// Shared "Notifications" switch used by every channel card (Signal, Matrix,
// Discord, Slack, …). Toggles the channel's membership in the notifyChannels
// allowlist via the setChannel action — no per-channel toggle component.

import { Switch } from "@/components/ui/switch";
import { useAssistantAction } from "@/lib/api";
import type { ChannelId } from "@rigel/k8s";

export function NotifyToggle({
  channelId,
  namespace,
  enabled,
}: {
  channelId: ChannelId;
  namespace: string;
  enabled: boolean;
}) {
  const setChannel = useAssistantAction();

  return (
    <label className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Notifications</span>
      <Switch
        checked={enabled}
        disabled={setChannel.isPending}
        onCheckedChange={(next) => {
          void setChannel.mutateAsync({
            action: "setChannel",
            namespace,
            channel: channelId,
            channelNotify: next,
          });
        }}
      />
    </label>
  );
}
