import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { handoffToChat } from "@/lib/chatHandoff";
import { moveToNamespacePrompt } from "@/panels/components/chatHandoffPrompts";
import type { Deployment } from "./types";

/**
 * Move-to-namespace — picks a target namespace, then hands a clone-then-delete
 * plan to the chat copilot (no native k8s move; each step is gated). Mirrors the
 * Swift DeploymentMoveSheet → moveDeploymentPrompt handoff.
 */
export function MoveToNamespaceDialog({
  deployment,
  namespaces,
  onClose,
}: {
  deployment: Deployment;
  namespaces: string[];
  onClose: () => void;
}) {
  const src = deployment.metadata.namespace ?? "default";
  const [target, setTarget] = useState("");
  const trimmed = target.trim();
  const valid = trimmed !== "" && trimmed !== src;

  function submit() {
    if (!valid) return;
    handoffToChat(moveToNamespacePrompt(deployment.metadata.name, src, trimmed));
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {deployment.metadata.name} to another namespace</DialogTitle>
          <DialogDescription>
            From <span className="font-mono">{src}</span>. There's no native move — Rigel will recreate it (and related resources) in the target namespace, then delete the originals, with each step confirmed in chat.
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Target namespace</span>
          <input
            list="ns-move-options"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="e.g. staging"
            autoFocus
            spellCheck={false}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
          />
          <datalist id="ns-move-options">
            {namespaces.filter((n) => n !== src).map((n) => <option key={n} value={n} />)}
          </datalist>
          {trimmed === src && <span className="text-xs text-destructive">Pick a namespace different from the source.</span>}
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!valid}>Plan move in chat</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
