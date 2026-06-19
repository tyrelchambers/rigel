// Reusable modal shell matching the Pencil "Connect AI Agent" design:
//   • <Modal>     — title on the left, X on the right, content below.
//   • <TabModal>  — same header, but a tab row sits in the header and the
//                   active panel renders in the body below.
// The header shares the modal's graphite body color and is set off only by a
// hairline bottom border; generous body padding gives the content room.
import { useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./dialog";
import { cn } from "@/lib/utils";

const MODAL_BG = "#101012";
const HEADER_BORDER = "rgba(255,255,255,0.07)";
// Outer drop shadow + a 1px inset hairline border (replaces the dialog's ring).
const MODAL_SHADOW = "0 30px 80px rgba(0,0,0,0.44), inset 0 0 0 1px rgba(255,255,255,0.10)";
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
        style={{ background: MODAL_BG, borderRadius: 20, boxShadow: MODAL_SHADOW }}
      >
        {/* Accessible title (the visible one lives in the header) */}
        <DialogTitle className="sr-only">{title}</DialogTitle>

        {/* Header bar — same graphite as the body, set off by a hairline */}
        <div
          className="flex shrink-0 items-center justify-between gap-4"
          style={{ borderBottom: `1px solid ${HEADER_BORDER}`, padding: "16px 20px" }}
        >
          <div className="min-w-0 flex-1">{header}</div>
          <DialogClose
            className="flex shrink-0 items-center justify-center rounded-[9px] transition-colors hover:bg-white/[0.05]"
            style={{ width: 34, height: 34 }}
          >
            <XIcon className="size-5" style={{ color: MUTED }} />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto" style={{ padding: "44px 40px 48px" }}>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  maxWidth?: string;
  children: ReactNode;
}

/** General modal: a graphite header with the title on the left + X on the right. */
export function Modal({ open, onOpenChange, title, maxWidth, children }: ModalProps) {
  return (
    <ModalFrame
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      maxWidth={maxWidth}
      header={<h2 style={{ fontSize: 18, fontWeight: 700, color: "#FFFFFF" }}>{title}</h2>}
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
        <div className="flex" style={{ gap: 4 }}>
          {tabs.map((t) => {
            const isActive = t.id === current?.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActive(t.id)}
                className="transition-colors hover:bg-white/[0.04]"
                style={{
                  padding: "9px 16px",
                  borderRadius: 10,
                  fontSize: 15,
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? "#FFFFFF" : MUTED,
                  background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      }
    >
      {current?.content}
    </ModalFrame>
  );
}
