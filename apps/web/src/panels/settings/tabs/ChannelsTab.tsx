import { useState } from "react";
import { useSettings } from "../useSettings";
import { SignalSection } from "../SignalSection";
import { MatrixSection } from "../MatrixSection";

export function ChannelsTab() {
  const [applying, setApplying] = useState(false);
  const derived = useSettings(applying);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Channels</h2>
        <p className="text-xs text-muted-foreground">How you reach the assistant from your phone.</p>
      </div>
      <SignalSection derived={derived} applying={applying} setApplying={setApplying} />
      <MatrixSection derived={derived} />
    </div>
  );
}
