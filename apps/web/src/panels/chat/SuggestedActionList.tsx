import { Button } from "@/components/ui/button";
import type { SuggestedAction } from "@/lib/actionBlocks";
import { iconForKind } from "./actionIcons";

interface Props {
  actions: SuggestedAction[];
  onAction: (action: SuggestedAction) => void;
}

/**
 * SuggestedActionList — one button per parsed action, shown below an assistant
 * message. Tapping opens the ConfirmSheet (single-action flow; the "Run
 * selected" batch flow is deferred for MVP).
 */
export function SuggestedActionList({ actions, onAction }: Props) {
  if (actions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {actions.map((action, i) => {
        const Icon = iconForKind(action.kind);
        const destructive = action.destructive === true || action.kind === "purge";
        return (
          <Button
            key={`${action.kind}-${i}`}
            size="sm"
            variant={destructive ? "destructive" : "default"}
            onClick={() => onAction(action)}
          >
            <Icon />
            {action.label}
          </Button>
        );
      })}
    </div>
  );
}
