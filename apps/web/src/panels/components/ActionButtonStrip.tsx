/**
 * ActionButtonStrip — a row of small ghost icon+label buttons.
 *
 * Renders the Errors / Logs / Explain chat-handoff buttons (and optionally
 * more panel-specific buttons) matching ActionButtonStrip.swift.
 *
 * Ghost buttons use:
 *   - border: 1px solid #1A1A1A
 *   - background: #141417
 *   - text: #A1A1AA
 *   - hover: bg #1A1A1A
 *   - font: monospace 10px medium
 *
 * Usage:
 *   <ActionButtonStrip
 *     onErrors={() => handoffToChat(errorsPrompt)}
 *     onLogs={() => handoffToChat(logsPrompt)}
 *     onExplain={() => handoffToChat(explainPrompt)}
 *     extra={[
 *       { label: "Delete", Icon: Trash2, onClick: handleDelete, destructive: true },
 *     ]}
 *   />
 */
import { TriangleAlert, ScrollText, CircleHelp, type LucideIcon } from "lucide-react";

export interface ExtraAction {
  label: string;
  Icon: LucideIcon;
  onClick: (e: React.MouseEvent) => void;
  /** When true, text is colored red (#EF4444) instead of gray. */
  destructive?: boolean;
}

interface ActionButtonStripProps {
  onErrors: (e: React.MouseEvent) => void;
  onLogs: (e: React.MouseEvent) => void;
  onExplain: (e: React.MouseEvent) => void;
  /** Optional extra panel-specific buttons shown after the standard trio. */
  extra?: ExtraAction[];
}

interface GhostButtonProps {
  Icon: LucideIcon;
  label: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  destructive?: boolean;
}

function GhostButton({ Icon, label, title, onClick, destructive }: GhostButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 transition-colors hover:bg-[#1A1A1A]"
      style={{
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
        fontWeight: 500,
        color: destructive ? "#EF4444" : "#A1A1AA",
        border: "1px solid #1A1A1A",
        background: "#141417",
      }}
    >
      <Icon className="size-2.5" />
      <span>{label}</span>
    </button>
  );
}

export function ActionButtonStrip({ onErrors, onLogs, onExplain, extra }: ActionButtonStripProps) {
  return (
    <span className="flex items-center gap-1 shrink-0">
      <GhostButton
        Icon={TriangleAlert}
        label="Errors"
        title="Ask Claude: Errors"
        onClick={onErrors}
      />
      <GhostButton
        Icon={ScrollText}
        label="Logs"
        title="Ask Claude: Logs"
        onClick={onLogs}
      />
      <GhostButton
        Icon={CircleHelp}
        label="Explain"
        title="Ask Claude: Explain"
        onClick={onExplain}
      />
      {extra?.map((action) => (
        <GhostButton
          key={action.label}
          Icon={action.Icon}
          label={action.label}
          title={action.label}
          onClick={action.onClick}
          destructive={action.destructive}
        />
      ))}
    </span>
  );
}
