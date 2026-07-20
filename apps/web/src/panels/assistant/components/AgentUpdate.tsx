import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleArrowUp, faCheck, faCloudSlash, faCircleInfo } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useUpdatesByImage, type UpdateResult } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { withTag } from "@/panels/catalog/updateTargets";

function Divider() {
  return <span aria-hidden className="h-[22px] w-px shrink-0 bg-[var(--border-strong)]" />;
}

/** Pure render of the agent update indicator. Returns null when there is nothing
 *  to show (no result yet). Trailing divider separates it from the token group. */
export function AgentUpdateView({
  result,
  onUpdate,
}: {
  result: UpdateResult | undefined | null;
  onUpdate: (latest: string) => void;
}) {
  if (!result) return null;

  if (result.updateAvailable && result.latest) {
    const latest = result.latest;
    return (
      <>
        <span className="flex items-center gap-2 whitespace-nowrap rounded-md border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.1)] px-2.5 py-1">
          <FontAwesomeIcon icon={faCircleArrowUp} className="size-3.5 shrink-0 text-[var(--status-pending)]" />
          {result.currentTag && (
            <>
              <span className="font-mono text-xs text-[var(--fg-tertiary)]">{result.currentTag}</span>
              <span aria-hidden className="font-mono text-xs text-[var(--fg-tertiary)]">→</span>
            </>
          )}
          <span className="font-mono text-xs font-semibold text-[var(--status-pending)]">{latest}</span>
        </span>
        <button
          type="button"
          onClick={() => onUpdate(latest)}
          className="rounded-md border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.06)] px-2.5 py-1 text-xs font-semibold text-[var(--status-pending)] hover:border-[rgba(245,158,11,0.5)] hover:bg-[rgba(245,158,11,0.12)]"
        >
          Update
        </button>
        <Divider />
      </>
    );
  }

  if (result.kind === "unknown") {
    return (
      <>
        <span
          title={result.reason}
          className="flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--fg-tertiary)]"
        >
          <FontAwesomeIcon icon={faCloudSlash} className="size-3.5 shrink-0" />
          Couldn't check for updates
          <FontAwesomeIcon icon={faCircleInfo} className="size-3 shrink-0" />
        </span>
        <Divider />
      </>
    );
  }

  return (
    <>
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--fg-tertiary)]">
        <FontAwesomeIcon icon={faCheck} className="size-3.5 shrink-0 text-[var(--status-running)]" />
        Up to date
        {result.currentTag && <span className="font-mono">{result.currentTag}</span>}
      </span>
      <Divider />
    </>
  );
}

/** Reads the running agent image, checks it against the registry, and renders the
 *  indicator. The Update button opens the standard setImage ConfirmSheet. */
export function AgentUpdate() {
  const { d, runSuggestion } = useAssistantCtx();
  const image = d.agentImage;
  const updates = useUpdatesByImage(image ? [{ image }] : []);
  const result = image ? updates.get(image)?.result : undefined;

  if (!image) return null;

  const onUpdate = (latest: string) => {
    runSuggestion({
      kind: "setImage",
      label: `Update agent to ${latest}`,
      name: "rigel-assistant",
      namespace: d.installedNamespace ?? d.stateNamespace,
      resourceKind: "deployment",
      container: d.agentContainer ?? "agent",
      image: withTag(image, latest),
    });
  };

  return <AgentUpdateView result={result} onUpdate={onUpdate} />;
}
