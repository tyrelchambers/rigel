import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

/**
 * Shimmer — a lightweight animated "working" label. The text softly pulses
 * while an activity is in flight (e.g. the assistant thinking). Pure Tailwind,
 * no animation library.
 */
export function Shimmer({ className, children, ...props }: ComponentProps<"span">) {
  return (
    <span className={cn("inline-block animate-pulse text-muted-foreground", className)} {...props}>
      {children}
    </span>
  );
}
