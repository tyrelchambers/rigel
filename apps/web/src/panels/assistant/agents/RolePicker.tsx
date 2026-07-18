// RolePicker — provider + model + reasoning-effort controls for one Assistant
// role (Worker or Supervisor). Controlled: value + onChange. Reuses the chat's
// AgentGlyph + useAgentModels so the choices match the chat exactly.
import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown } from "@awesome.me/kit-6050953220/icons/classic/solid";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { TabBar, Tab } from "@/components/ui/Tabs";
import { AgentGlyph } from "@/panels/settings/agents/agentGlyphs";
import { useAgentModels, useAgents, type AgentId, type AssistantRoleSelection } from "@/lib/api";
import { effortName } from "@/panels/chat/composerModel";
import { Card, Field } from "../components/primitives";
import { PROVIDER_IDS } from "./providerMeta";

export function RolePicker({
  label,
  description,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  value: AssistantRoleSelection;
  onChange: (next: AssistantRoleSelection) => void;
  disabled?: boolean;
}) {
  const provider = value.provider as AgentId;
  const { data: agents } = useAgents();
  const { data: agentModels } = useAgentModels(provider);
  const models = agentModels?.models ?? [];
  const efforts = agentModels?.efforts ?? [];

  // pendingProvider tracks a provider switch in-flight: we fetch its models and
  // once they arrive we call onChange with the first model to complete the reset.
  const [pendingProvider, setPendingProvider] = useState<AgentId | null>(null);
  const { data: pendingModels } = useAgentModels(pendingProvider ?? undefined);

  useEffect(() => {
    if (!pendingProvider || !pendingModels?.models.length) return;
    onChange({ provider: pendingProvider, model: pendingModels.models[0]! });
    setPendingProvider(null);
  }, [pendingProvider, pendingModels, onChange]);

  const providerLabel = agents?.agents?.find((a) => a.id === provider)?.label ?? provider;

  function pickProvider(next: AgentId) {
    if (next === provider) return;
    // Fire onChange immediately so the parent is updated to the new provider;
    // the pending effect will fire again once the new provider's models load to
    // correct the model to the first advertised one.
    setPendingProvider(next);
  }

  return (
    <Card className="space-y-2.5">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      <Field label="Provider" labelWidth="w-20">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
            className="flex flex-1 items-center justify-between rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            aria-label="Provider"
          >
            <span className="flex items-center gap-2">
              <AgentGlyph id={provider} size={16} />
              {providerLabel}
            </span>
            <FontAwesomeIcon icon={faChevronDown} className="size-4 shrink-0 text-primary" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {PROVIDER_IDS.map((id) => (
              <DropdownMenuItem key={id} onClick={() => pickProvider(id)}>
                <span className="flex items-center gap-2">
                  <AgentGlyph id={id} size={16} />
                  {agents?.agents?.find((a) => a.id === id)?.label ?? id}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </Field>

      <Field label="Model" labelWidth="w-20">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled || models.length === 0}
            className="flex flex-1 items-center justify-between rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            aria-label="Model"
          >
            <span className="truncate">{value.model || "Select a model"}</span>
            <FontAwesomeIcon icon={faChevronDown} className="size-4 shrink-0 text-primary" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {models.map((m) => (
              <DropdownMenuItem key={m} onClick={() => onChange({ ...value, model: m })}>
                {m}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </Field>

      {efforts.length > 0 && (
        <Field label="Reasoning" labelWidth="w-20">
          <TabBar value={value.effort ?? "high"} onValueChange={(id) => onChange({ ...value, effort: id })}>
            {efforts.map((e) => (
              <Tab key={e} value={e}>{effortName(e)}</Tab>
            ))}
          </TabBar>
        </Field>
      )}
    </Card>
  );
}
