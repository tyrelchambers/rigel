// Right-click context menu — shadcn-style wrapper over Base UI's ContextMenu
// (same library as dropdown-menu, so styling/behavior match). Overrides the
// native browser menu and renders our own at the pointer. Used by ListRow so
// every list panel gets per-row actions on right-click.
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import { cn } from "@/lib/utils"

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-50">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "min-w-44 rounded-lg bg-popover p-1 text-xs text-popover-foreground ring-1 ring-foreground/10 shadow-md outline-none",
            className
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  variant = "default",
  ...props
}: ContextMenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        // --muted == --popover in this theme, so highlight with a visible white wash instead.
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs outline-none select-none transition-colors hover:bg-white/[0.07] hover:text-foreground data-highlighted:bg-white/[0.07] data-highlighted:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-3 [&_svg]:shrink-0",
        variant === "destructive" &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function ContextMenuLabel({ className, ...props }: ContextMenuPrimitive.GroupLabel.Props) {
  return (
    <ContextMenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      className={cn("px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
}
