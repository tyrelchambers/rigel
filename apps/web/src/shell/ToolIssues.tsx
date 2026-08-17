import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowsRotate,
  faArrowUpRightFromSquare,
  faTriangleExclamation,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCluster, type MissingTool } from "@/store/cluster";
import { sendToolsRecheck } from "@/lib/ws";

const CONSEQUENCE: Record<MissingTool["bin"], string> = {
  kubectl: "Watches, logs, metrics and port-forward can't run.",
  helm: "Catalog installs and upgrades can't run.",
};

function IssueRow({ tool }: { tool: MissingTool }) {
  return (
    <div className="flex items-start gap-2.5 px-3.5 py-3">
      <FontAwesomeIcon
        icon={faTriangleExclamation}
        className="mt-0.5 size-[15px] shrink-0"
        style={{ color: "var(--status-pending)" }}
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold" style={{ color: "var(--fg-primary)" }}>
          {tool.bin} not found
        </span>
        <span className="text-2xs" style={{ color: "var(--fg-secondary)" }}>
          {CONSEQUENCE[tool.bin]}
        </span>
        {/* target=_blank so the desktop's window-open handler sends it to the
            system browser instead of navigating the app window. */}
        <a
          href={tool.installUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 flex items-center gap-1.5 text-2xs font-semibold underline"
          style={{ color: "var(--accent-primary)" }}
        >
          Install {tool.bin}
          <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="size-[11px]" />
        </a>
      </div>
    </div>
  );
}

/**
 * Header indicator for required binaries the server can't find. Renders nothing
 * while everything resolves, so the header is unchanged in the healthy case.
 */
export function ToolIssues({ style }: { style?: React.CSSProperties }) {
  const missingTools = useCluster((s) => s.missingTools);
  const [open, setOpen] = useState(false);
  if (missingTools.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`${missingTools.length} tool ${missingTools.length === 1 ? "issue" : "issues"}`}
        title="Missing tools"
        style={{ ...style, background: "var(--surface-sunken)", borderColor: "var(--status-pending)" }}
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-opacity hover:opacity-90"
      >
        <FontAwesomeIcon
          icon={faTriangleExclamation}
          className="size-[14px]"
          style={{ color: "var(--status-pending)" }}
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[372px] gap-0 overflow-hidden p-0">
        <div
          className="flex items-center border-b px-3.5 py-2.5"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <span className="text-xs font-semibold" style={{ color: "var(--fg-primary)" }}>
            Issues
          </span>
          <span className="ml-auto font-mono text-2xs" style={{ color: "var(--fg-tertiary)" }}>
            {missingTools.length}
          </span>
        </div>

        {missingTools.map((tool, i) => (
          <div key={tool.bin}>
            {i > 0 && <div className="h-px" style={{ background: "var(--border-subtle)" }} />}
            <IssueRow tool={tool} />
          </div>
        ))}

        <div
          className="flex items-center border-t px-3.5 py-2.5"
          style={{ borderColor: "var(--border-subtle)", background: "var(--surface-sunken)" }}
        >
          <button
            onClick={() => sendToolsRecheck()}
            className="flex cursor-pointer items-center gap-1.5 text-2xs font-semibold transition-opacity hover:opacity-90"
            style={{ color: "var(--accent-primary)" }}
          >
            <FontAwesomeIcon icon={faArrowsRotate} className="size-[11px]" />
            Check again
          </button>
          <span className="ml-auto text-3xs" style={{ color: "var(--fg-tertiary)" }}>
            rechecking every 10s
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
