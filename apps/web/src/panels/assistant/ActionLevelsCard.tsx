import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faArrowsRotate,
  faClockRotateLeft,
  faTrash,
  faBan,
  faCircleCheck,
  faLayerGroup,
  faSliders,
  faCodePullRequest,
  faCircleInfo,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { PRESETS, ACTION_LEVEL_KINDS, ACTION_LEVEL_LABELS, matchPreset, type ActionKind, type ActionLevel, type PresetId } from "@rigel/k8s";
import { cn } from "@/lib/utils";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { useAssistantCtx } from "./AssistantContext";

const LEVELS: { value: ActionLevel; label: string; dot: string; def: string }[] = [
  { value: "auto", label: ACTION_LEVEL_LABELS.auto, dot: "bg-[var(--status-running)]", def: "Runs it" },
  { value: "review", label: ACTION_LEVEL_LABELS.review, dot: "bg-[var(--accent-primary)]", def: "Supervisor must approve" },
  { value: "ask", label: ACTION_LEVEL_LABELS.ask, dot: "bg-[var(--status-pending)]", def: "Waits for your OK" },
  { value: "off", label: ACTION_LEVEL_LABELS.off, dot: "bg-[var(--fg-tertiary)]", def: "Never does it" },
];

const PRESET_OPTIONS: SegmentedOption<PresetId>[] = [
  { value: "loose", label: "Loose" },
  { value: "balanced", label: "Balanced" },
  { value: "strict", label: "Strict" },
];

const KIND_ICONS: Record<ActionKind, IconDefinition> = {
  restart: faArrowsRotate,
  rollback: faClockRotateLeft,
  deletePod: faTrash,
  cordon: faBan,
  uncordon: faCircleCheck,
  scale: faLayerGroup,
  setEnv: faSliders,
  openFixPR: faCodePullRequest,
};

export function ActionLevelsCard() {
  const { d, ns, working, run } = useAssistantCtx();
  const current = matchPreset(d.actionLevels);
  const save = (actionLevels = d.actionLevels) => run({ action: "setActionLevels", namespace: ns, actionLevels });

  return (
    <div className="flex flex-col gap-[18px] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[22px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-base font-semibold text-[var(--fg-primary)]">Action levels</p>
          <p className="text-xs text-[var(--fg-tertiary)]">How much the agent may do on its own, per action.</p>
        </div>
        <div className="flex items-center gap-2.5">
          {current === null && (
            <span className="flex items-center gap-1.5 rounded-full bg-[var(--status-pending)]/10 px-2.5 py-1 text-xs font-semibold text-[var(--status-pending)]">
              <span className="size-1.5 rounded-full bg-[var(--status-pending)]" />
              Custom
            </span>
          )}
          <Segmented
            value={current}
            onChange={(id) => save(PRESETS[id])}
            options={PRESET_OPTIONS}
            disabled={working}
            segmentClassName="px-3"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-[18px] rounded-md bg-[var(--surface-sunken)] px-3 py-2.5">
        {LEVELS.map((l) => (
          <div key={l.value} className="flex items-center gap-1.5 text-xs">
            <span className={cn("size-[7px] rounded-full", l.dot)} />
            <span className="font-semibold text-[var(--fg-primary)]">{l.label}</span>
            <span className="text-[var(--fg-tertiary)]">{l.def}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col">
        {ACTION_LEVEL_KINDS.map(({ kind, label, description }, i) => (
          <div
            key={kind}
            className={cn("flex items-center gap-3 py-3", i > 0 && "border-t border-[var(--border-subtle)]")}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/5">
              <FontAwesomeIcon icon={KIND_ICONS[kind]} className="size-3.5 text-[var(--fg-secondary)]" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-sm font-semibold text-[var(--fg-primary)]">{label}</p>
              <p className="text-xs text-[var(--fg-tertiary)]">{description}</p>
            </div>
            <Segmented
              value={d.actionLevels[kind]}
              onChange={(level) => save({ ...d.actionLevels, [kind]: level })}
              options={LEVELS.map((l) => ({ value: l.value, label: l.label, ariaLabel: `${label}: ${l.label}`, dot: l.dot }))}
              disabled={working}
              segmentClassName="w-[66px]"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5 text-xs text-[var(--fg-tertiary)]">
        <FontAwesomeIcon icon={faCircleInfo} className="size-3.5 shrink-0" />
        <span>Autonomy mode still applies on top: Advisory and quiet hours hold every change for your OK.</span>
      </div>
    </div>
  );
}
