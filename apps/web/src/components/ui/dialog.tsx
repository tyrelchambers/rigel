import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

// Graphite shell — the app-wide default for every dialog. Padding-free flex
// column: DialogHeader / DialogBody / DialogFooter own their own spacing.
// Anchored a fixed distance from the top (not vertically centered) so the modal
// doesn't jump as its content height changes. The bespoke #101012 graphite
// (darker than --surface-primary on purpose) lives here and nowhere else.
function DialogContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-[8vh] left-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-[#101012] text-sm text-popover-foreground shadow-[0_30px_80px_rgba(0,0,0,0.45)] ring-1 ring-white/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

// The one header treatment: a hairline-separated bar. Children (a DialogTitle,
// a DialogIcon + DialogTitle, or a tab row) sit on the left; the close X is
// rendered here on the right unless showClose is false.
function DialogHeader({
  className,
  showClose = true,
  children,
  ...props
}: React.ComponentProps<"div"> & { showClose?: boolean }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex shrink-0 items-center justify-between gap-4 border-b border-white/[0.07] px-[18px] py-3.5",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">{children}</div>
      {showClose && (
        <DialogPrimitive.Close
          data-slot="dialog-close"
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
            />
          }
        >
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

// Leading-icon tile for a header (ports the old ModalIcon). background={false}
// for a bare icon. Icon inherits white via currentColor.
function DialogIcon({
  background = true,
  className,
  ...props
}: React.ComponentProps<"div"> & { background?: boolean }) {
  return (
    <div
      data-slot="dialog-icon"
      className={cn(
        "flex size-[30px] shrink-0 items-center justify-center text-white",
        background && "rounded-lg bg-white/[0.07]",
        className,
      )}
      {...props}
    />
  );
}

// The one padded scroll region. Everything between header and footer goes here.
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("flex-1 overflow-y-auto px-6 pt-6 pb-7", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-white/[0.07] px-6 py-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
