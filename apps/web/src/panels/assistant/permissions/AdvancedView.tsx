// AdvancedView — the resource x verb matrix. Pencil frame riSgI.
import { Fragment } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faLock } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { cn } from "@/lib/utils";
import { cell, hasCell, isBaselineReadCell, MATRIX_RESOURCES, VERBS, type RbacPolicy } from "@rigel/k8s";

/** Display label for an apiGroup's group-header row ("" -> "core"). */
function groupLabel(apiGroup: string): string {
  return apiGroup === "" ? "core" : apiGroup;
}

/** MATRIX_RESOURCES grouped by apiGroup, preserving source order. */
function groupedResources() {
  const groups: { apiGroup: string; resources: typeof MATRIX_RESOURCES }[] = [];
  for (const r of MATRIX_RESOURCES) {
    let g = groups.find((g) => g.apiGroup === r.apiGroup);
    if (!g) {
      g = { apiGroup: r.apiGroup, resources: [] };
      groups.push(g);
    }
    g.resources.push(r);
  }
  return groups;
}

export function AdvancedView({
  staged,
  onToggleCell,
  disabled = false,
}: {
  staged: RbacPolicy;
  onToggleCell: (cellKey: string, on: boolean) => void;
  disabled?: boolean;
}) {
  const groups = groupedResources();
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
        <table className="w-full min-w-[560px] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-[var(--border-subtle)] text-2xs tracking-wide text-[var(--fg-tertiary)] uppercase">
              <th className="px-4 py-2.5 font-medium">Resource</th>
              {VERBS.map((v) => (
                <th key={v} className="px-2 py-2.5 text-center font-medium">
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.apiGroup || "core"}>
                <tr>
                  <td
                    colSpan={VERBS.length + 1}
                    className="bg-white/[0.03] px-4 py-1.5 font-mono text-2xs font-semibold text-[var(--fg-tertiary)]"
                  >
                    {groupLabel(g.apiGroup)}
                  </td>
                </tr>
                {g.resources.map((r) => {
                  const allowedVerbs = r.onlyVerbs ?? VERBS;
                  return (
                    <tr
                      key={`${r.apiGroup}|${r.resource}`}
                      className={cn(
                        "border-b border-[var(--border-subtle)]/60 last:border-b-0",
                        r.secret && "bg-red-500/[0.04]",
                      )}
                    >
                      <td className="px-4 py-2 font-mono text-xs text-[var(--fg-primary)]">
                        <span className="inline-flex items-center gap-1.5">
                          {r.resource}
                          {r.secret && <FontAwesomeIcon icon={faLock} className="size-3 shrink-0 text-red-400" aria-hidden />}
                        </span>
                      </td>
                      {VERBS.map((v) => {
                        const allowed = (allowedVerbs as readonly string[]).includes(v);
                        const c = cell(r.apiGroup, r.resource, v);
                        const baseline = isBaselineReadCell(c);
                        return (
                          <td key={v} className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              aria-label={`${r.resource} ${v}`}
                              checked={baseline || hasCell(staged, c)}
                              disabled={disabled || !allowed || baseline}
                              onChange={(e) => onToggleCell(c, e.target.checked)}
                              className="size-[15px] accent-[var(--accent-primary)] disabled:opacity-20"
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-start gap-1.5 text-xs text-[var(--fg-tertiary)]">
        <FontAwesomeIcon icon={faLock} className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          Secrets and roles / rolebindings aren&apos;t editable here — the assistant can never read
          secrets or escalate itself. Reads are always on (a non-editable baseline).
        </span>
      </div>
    </div>
  );
}
