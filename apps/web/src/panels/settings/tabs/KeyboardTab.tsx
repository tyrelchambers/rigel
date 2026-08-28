import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatShortcut } from "@/lib/platform";
import { COMMANDS, COMMAND_BY_ID, COMMAND_GROUPS, type CommandId } from "@/lib/shortcuts/registry";
import { findConflict, resolveSpec } from "@/lib/shortcuts/resolve";
import { hasModifier, specFromEvent } from "@/lib/shortcuts/record";
import { useShortcutStore } from "@/store/shortcuts";
import { ShortcutRow } from "../ShortcutRow";

export function KeyboardTab() {
  const overrides = useShortcutStore((s) => s.overrides);
  const setOverride = useShortcutStore((s) => s.setOverride);
  const reset = useShortcutStore((s) => s.reset);
  const resetAll = useShortcutStore((s) => s.resetAll);
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [problem, setProblem] = useState<{ id: CommandId; message: string } | null>(null);

  const capture = useCallback(
    (id: CommandId, e: KeyboardEvent) => {
      const spec = specFromEvent(e);
      if (!spec) return;
      const clash = findConflict(spec, id, overrides);
      if (clash) {
        const label = COMMAND_BY_ID.get(clash)?.label ?? clash;
        setProblem({ id, message: `${formatShortcut(spec)} is already ${label}.` });
        setRecording(null);
        return;
      }
      setOverride(id, spec);
      setRecording(null);
      setProblem(
        hasModifier(spec)
          ? null
          : { id, message: "This binding will not fire while you are typing in a text field." },
      );
    },
    [overrides, setOverride],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <p className="text-sm text-[var(--fg-secondary)]">
          Rebind any shortcut. Recording replaces the current binding once you press a combination no
          other command uses.
        </p>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={resetAll}>
          Reset all
        </Button>
      </div>
      <div className="flex flex-col gap-6">
        {COMMAND_GROUPS.map((group) => {
          const rows = COMMANDS.filter((c) => c.group === group);
          if (rows.length === 0) return null;
          return (
            <div key={group} className="flex flex-col gap-0.5">
              <h2 className="pb-1.5 font-mono text-3xs font-semibold tracking-wider text-[var(--fg-tertiary)] uppercase">
                {group}
              </h2>
              {rows.map((command) => (
                <ShortcutRow
                  key={command.id}
                  command={command}
                  spec={resolveSpec(command.id, overrides)}
                  overridden={command.id in overrides}
                  recording={recording === command.id}
                  problem={problem?.id === command.id ? problem.message : null}
                  onRecord={() => {
                    setProblem(null);
                    setRecording(command.id);
                  }}
                  onCapture={(e) => capture(command.id, e)}
                  onCancel={() => setRecording(null)}
                  onReset={() => {
                    setProblem(null);
                    reset(command.id);
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
