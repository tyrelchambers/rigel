// Reusable modal shell built on the shared graphite Dialog primitive:
//   • <Modal>     — title on the left, X on the right, content below.
//   • <TabModal>  — same header, but a tab row sits in the header and the
//                   active panel renders in the body below.
// Background, corner radius, hairline ring, shadow and top-anchored position
// all come from DialogContent (the app-wide default). This component only adds
// the header bar (hairline-separated) and padded body.
import { useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./dialog";
import { cn } from "@/lib/utils";
import { SegmentedTabs } from "./SegmentedTabs";

const HEADER_BORDER = "rgba(255,255,255,0.07)";
const MUTED = "#8C8C95";

interface FrameProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title (also the visible title for <Modal>). */
  title: string;
  /** Left side of the header bar — a title for Modal, the tab row for TabModal. */
  header: ReactNode;
  /** Tailwind max-width override, e.g. "!max-w-4xl". */
  maxWidth?: string;
  children: ReactNode;
}

/** Shared frame: hairline-separated header (left content + X), padded body below. */
function ModalFrame({ open, onOpenChange, title, header, maxWidth = "!max-w-2xl", children }: FrameProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex max-h-[85vh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0",
          maxWidth,
        )}
      >
        {/* Accessible title (the visible one lives in the header) */}
        <DialogTitle className="sr-only">{title}</DialogTitle>

        {/* Header bar — same graphite as the body, set off by a hairline */}
        <div
          className="flex shrink-0 items-center justify-between gap-4"
          style={{ borderBottom: `1px solid ${HEADER_BORDER}`, padding: "14px 18px" }}
        >
          <div className="min-w-0 flex-1">{header}</div>
          <DialogClose
            className="flex shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.05]"
            style={{ width: 30, height: 30 }}
          >
            <XIcon className="size-4" style={{ color: MUTED }} />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto" style={{ padding: "24px 24px 28px" }}>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Small leading-icon tile for a modal header. By default the icon sits on a
 * subtle rounded background; pass `background={false}` for a bare icon. The
 * icon inherits white via `currentColor` unless the passed node overrides it.
 */
export function ModalIcon({ children, background = true }: { children: ReactNode; background?: boolean }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={{
        width: 30,
        height: 30,
        color: "#FFFFFF",
        borderRadius: background ? 8 : undefined,
        background: background ? "rgba(255,255,255,0.07)" : undefined,
      }}
    >
      {children}
    </div>
  );
}

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  maxWidth?: string;
  /** Optional leading icon, shown in a tile to the left of the title. */
  icon?: ReactNode;
  /** Whether the icon sits on a rounded background tile. Default true. */
  iconBackground?: boolean;
  children: ReactNode;
}

/** General modal: a graphite header with the title (and optional icon) on the left + X on the right. */
export function Modal({ open, onOpenChange, title, maxWidth, icon, iconBackground = true, children }: ModalProps) {
  return (
    <ModalFrame
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      maxWidth={maxWidth}
      header={
        <div className="flex items-center gap-2.5">
          {icon && <ModalIcon background={iconBackground}>{icon}</ModalIcon>}
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "#FFFFFF" }}>{title}</h2>
        </div>
      }
    >
      {children}
    </ModalFrame>
  );
}

export interface ModalTab {
  id: string;
  label: string;
  content: ReactNode;
}

interface TabModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title (the visible header shows the tabs). */
  title: string;
  tabs: ModalTab[];
  defaultTab?: string;
  maxWidth?: string;
}

/** Tab modal: the same graphite header, but with the tab row in the header. */
export function TabModal({ open, onOpenChange, title, tabs, defaultTab, maxWidth }: TabModalProps) {
  const [active, setActive] = useState<string>(defaultTab ?? tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <ModalFrame
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      maxWidth={maxWidth}
      header={
        <SegmentedTabs
          tabs={tabs.map((t) => ({ id: t.id, label: t.label }))}
          active={current?.id ?? ""}
          onChange={setActive}
        />
      }
    >
      {current?.content}
    </ModalFrame>
  );
}
