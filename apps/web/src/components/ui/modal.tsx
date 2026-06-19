// Reusable modal shell with a graphite header bar, generous padding, and two
// styles built on the shadcn/base-ui Dialog:
//   • <Modal>     — title on the left, X on the right, content below.
//   • <TabModal>  — same header, but tabs sit in the header and panels render
//                   in the body below.
// The header is a slightly lighter graphite (--surface-elevated) than the body
// (--surface-primary), with the close affordance pinned right.
import { useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./dialog";
import { Button } from "./button";
import { cn } from "@/lib/utils";

interface FrameProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title (also the visible title for <Modal>). */
  title: string;
  /** Left side of the header bar — a title for Modal, the tab row for TabModal. */
  header: ReactNode;
  /** Tailwind max-width override, e.g. "!max-w-3xl". */
  maxWidth?: string;
  children: ReactNode;
}

/** Shared frame: graphite header (left content + X), padded body below. */
function ModalFrame({ open, onOpenChange, title, header, maxWidth = "!max-w-2xl", children }: FrameProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex max-h-[85vh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0",
          maxWidth,
        )}
        style={{ background: "var(--surface-primary)" }}
      >
        {/* Accessible title (the visible one lives in the header) */}
        <DialogTitle className="sr-only">{title}</DialogTitle>

        {/* Header bar — slightly lighter graphite */}
        <div
          className="flex shrink-0 items-center justify-between gap-4"
          style={{
            background: "var(--surface-elevated)",
            borderBottom: "1px solid var(--border-subtle)",
            padding: "16px 28px",
          }}
        >
          <div className="min-w-0 flex-1">{header}</div>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" className="-mr-1.5 shrink-0" />}
          >
            <XIcon className="size-4" style={{ color: "var(--fg-secondary)" }} />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto" style={{ padding: "32px 28px" }}>
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
      header={
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-primary)" }}>{title}</h2>
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
        <div className="flex gap-1">
          {tabs.map((t) => {
            const isActive = t.id === current?.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActive(t.id)}
                className="rounded-md transition-colors hover:bg-white/[0.03]"
                style={{
                  padding: "6px 12px",
                  fontSize: 13,
                  fontWeight: 600,
                  color: isActive ? "var(--fg-primary)" : "var(--fg-tertiary)",
                  background: isActive ? "rgba(255,255,255,0.06)" : "transparent",
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
