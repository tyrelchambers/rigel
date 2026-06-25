import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toaster — app-wide toast host (sonner). Mounted once near the app root.
 *
 * The app is dark-themed via CSS variables, so we pin the dark theme and map
 * sonner's surface tokens onto our design tokens rather than pulling in
 * next-themes. Used to surface background action progress (see actionRunner).
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      closeButton
      richColors
      style={
        {
          "--normal-bg": "var(--surface-elevated)",
          "--normal-text": "var(--fg-primary)",
          "--normal-border": "var(--border-strong)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
