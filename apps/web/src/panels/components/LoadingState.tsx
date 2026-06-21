/**
 * LoadingState — a centered loader + message for the body of a panel while the
 * first batch of data is loading (before any rows/logs have arrived).
 */
import { Loader } from "@/components/Loader";

export function LoadingState({ message = "Loading…" }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
      <Loader size={26} color="var(--accent-primary)" label="loading" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
