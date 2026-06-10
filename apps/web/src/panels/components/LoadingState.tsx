/**
 * LoadingState — a centered spinner + message for the body of a panel while the
 * first batch of data is loading (before any rows/logs have arrived).
 */
import { LoaderCircle } from "lucide-react";

export function LoadingState({ message = "Loading…" }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
      <LoaderCircle className="size-6 animate-spin" style={{ color: "#A855F7" }} aria-label="loading" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
