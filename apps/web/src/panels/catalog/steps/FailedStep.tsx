import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Step 8 — Failed. Error message + Back / Retry / Hand off buttons. */
export function FailedStep({
  message,
  onBack,
  onRetry,
  onHandoff,
}: {
  message: string;
  onBack: () => void;
  onRetry: () => void;
  onHandoff: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <CircleAlert className="size-5 text-destructive" />
        <span className="font-medium">Installation failed</span>
      </div>
      <pre className="max-h-60 overflow-auto rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap">
        {message || "Unknown error"}
      </pre>
      <div className="flex justify-between gap-2">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onRetry}>
            Retry
          </Button>
          <Button type="button" onClick={onHandoff}>
            Hand off to chat
          </Button>
        </div>
      </div>
    </div>
  );
}
