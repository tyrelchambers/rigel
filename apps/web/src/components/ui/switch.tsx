// shadcn-style switch, adapted to the app's @base-ui primitive layer (the same
// pattern as dialog.tsx / button.tsx). Base UI exposes state as the
// data-checked / data-unchecked attributes, which drive the track + thumb.
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 outline-none transition-colors",
        "bg-white/15 data-[checked]:bg-primary",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform",
          "data-[unchecked]:translate-x-0 data-[checked]:translate-x-4",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
