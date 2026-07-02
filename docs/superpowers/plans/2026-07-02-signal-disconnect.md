# Signal Disconnect (Settings > Channels) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the user disconnect a linked Signal channel from Settings > Channels, behind a destructive confirm dialog, by clearing the Signal fields in the `assistant-config` ConfigMap that the agent's notifier reads — mirroring the Matrix "Disconnect" pattern but with a confirm step Matrix currently lacks.

**Where Signal is stored:** There is no Signal Secret. The connect/link flow persists everything into the `assistant-config` ConfigMap via a `setSignal` read-modify-write:
- `apps/web/src/panels/settings/SignalSection.tsx:104-114` (`saveLinkedNumber`) calls `setSignal.mutateAsync({ action: "setSignal", namespace, apiUrl: signalApiUrl(namespace), number, recipients, inbound })` right after the QR-link poll finds a linked number.
- `apps/server/src/assistant.ts:358-370` (`setSignal`) builds the patch via `signalConfigUpdates()` (`packages/k8s/src/signal.ts:230-242`) and read-modify-writes `assistant-config` (`patchConfig`, `apps/server/src/assistant.ts:341-351`) so unrelated keys (mode, kill-switch, digests…) are untouched.
- The four keys written are `signalApiUrl`, `signalNumber`, `signalRecipients`, `signalInbound` (`packages/k8s/src/signal.ts:206-218`).
- "Linked" status is derived purely from `hasSavedNumber()` — a non-empty `signalNumber` (`packages/k8s/src/signal.ts:220-223`, consumed by `deriveSignalBridgeStatus` at `packages/k8s/src/signal.ts:129-144` and by `useSettings` at `apps/web/src/panels/settings/useSettings.ts:144-152`).
- The agent notifier gates **every** Signal send/receive on `rc.signalApiUrl && rc.signalNumber` both being set (`agent/src/index.ts:737`, `:806`, `:1015-1016`; `agent/src/digest.ts:218-219`). Clearing either one immediately silences Signal notifications on the agent's next config read (`agent/src/runtimeConfig.ts:291-304` reads it live each tick, no restart needed).

**Reference (Matrix disconnect):** `apps/web/src/panels/settings/MatrixSection.tsx:82-97` already has a `disconnect()` that calls `setMatrix.mutateAsync({ action: "setMatrix", namespace, matrixHomeserverUrl: "", matrixUserId: "", matrixRoomId: "", matrixAllowedSenders: "", matrixInbound: false })` — but it has **no confirm step**, wired directly to the header's plain `<button>` (`MatrixSection.tsx:150-158`). This ticket explicitly wants Signal gated by a confirm dialog, so don't copy Matrix's lack of confirmation — only its clear-the-config approach.

**Approach:** Add a small destructive confirm `Dialog` (standardized primitives from `apps/web/src/components/ui/dialog.tsx`, not a Sheet — see `docs/superpowers/plans/2026-07-01-standardized-dialog-primitives.md`) triggered by a new "Disconnect" affordance on the `status === "linked"` header row in `SignalSection.tsx`. Confirming calls the existing `setSignal` assistant action with all four Signal fields cleared (`apiUrl/number/recipients: ""`, `inbound: false`) — no new server route needed, this is the same read-modify-write `setSignal` already uses for saving. The live `deployments`/`configmaps` watch that feeds `useSettings` picks up the ConfigMap change and `status` recomputes from `linked` back to `ready` (bridge still deployed, unlinked) with no extra plumbing, satisfying "reflect the state immediately."

**Open question (do not guess, flag for the ticket owner):** `signal-cli-rest-api`'s own linked-device identity/session data lives on the `signal-cli-data` PVC mounted into the `signal-cli-rest` pod (`packages/k8s/src/signal.ts:31-103`), not in anything the web app writes. Clearing `assistant-config` stops Rigel from sending/receiving on that number and flips the UI back to "ready," but it does **not** unregister the number from the signal-cli-rest-api container itself — the old device registration remains on the PVC. This plan only removes what "the connect flow persists" (the ConfigMap, per the ticket's own phrasing) and does not call a signal-cli unregister endpoint (none is currently wired in `apps/server/src/signal.ts`, which only exposes `link`/`accounts`/`status`/`sendTest`) or touch the PVC. If a true phone-side unlink is required, that's a separate follow-up (new server action + signal-cli-rest-api `DELETE`-account call) — flag with the user before adding it.

---

## Task 1: Add a disconnect-clears-everything regression test to the shared signal helpers

**Files:**
- Modify: `packages/k8s/src/signal.test.ts`

- [ ] **Step 1: Write the test**

  Add near the existing `signalConfigUpdates` tests (after the block at `packages/k8s/src/signal.test.ts:99-105`):

  ```ts
  test("signalConfigUpdates clears every key for a disconnect", () => {
    expect(
      signalConfigUpdates({ apiUrl: "", number: "", recipients: "", inbound: false }),
    ).toEqual({
      signalApiUrl: "",
      signalNumber: "",
      signalRecipients: "",
      signalInbound: "false",
    });
  });
  ```

- [ ] **Step 2: Run it**

  ```
  pnpm --filter @rigel/k8s test
  ```

  This should already pass with zero source changes (the function is generic over which fields are provided) — it's a regression lock so a future refactor of `signalConfigUpdates` can't silently stop clearing a field the disconnect flow relies on.

---

## Task 2: Build the `SignalDisconnectDialog` confirm component

**Files:**
- Create: `apps/web/src/panels/settings/SignalDisconnectDialog.tsx`
- Create: `apps/web/src/panels/settings/SignalDisconnectDialog.test.tsx`

- [ ] **Step 1: Write the failing tests**

  ```tsx
  // apps/web/src/panels/settings/SignalDisconnectDialog.test.tsx
  // @vitest-environment jsdom
  import { describe, it, expect, vi } from "vitest";
  import { render, screen, within } from "@testing-library/react";
  import { fireEvent } from "@testing-library/react";
  import { SignalDisconnectDialog } from "./SignalDisconnectDialog";

  describe("SignalDisconnectDialog", () => {
    it("renders no dialog when closed", () => {
      render(
        <SignalDisconnectDialog open={false} onOpenChange={() => {}} onConfirm={() => {}} pending={false} />,
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows the destructive confirm copy when open", () => {
      render(
        <SignalDisconnectDialog open onOpenChange={() => {}} onConfirm={() => {}} pending={false} />,
      );
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText(/disconnect signal/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/notifications stop immediately/i)).toBeInTheDocument();
    });

    it("calls onConfirm when the Disconnect button is clicked", () => {
      const onConfirm = vi.fn();
      render(
        <SignalDisconnectDialog open onOpenChange={() => {}} onConfirm={onConfirm} pending={false} />,
      );
      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: /^disconnect$/i }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("calls onOpenChange(false) when Cancel is clicked", () => {
      const onOpenChange = vi.fn();
      render(
        <SignalDisconnectDialog open onOpenChange={onOpenChange} onConfirm={() => {}} pending={false} />,
      );
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("disables both buttons while pending", () => {
      render(
        <SignalDisconnectDialog open onOpenChange={() => {}} onConfirm={() => {}} pending />,
      );
      expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /disconnecting/i })).toBeDisabled();
    });
  });
  ```

  Run `pnpm --filter web test -- SignalDisconnectDialog` and confirm it fails (module doesn't exist yet).

- [ ] **Step 2: Implement the component**

  ```tsx
  // apps/web/src/panels/settings/SignalDisconnectDialog.tsx
  //
  // Destructive confirm dialog for the Signal "Disconnect" action. Presentation
  // only — the actual teardown (clearing assistant-config's Signal keys via the
  // setSignal assistant action) lives in SignalSection.disconnect(). Uses the
  // standardized Dialog primitives (docs/superpowers/plans/
  // 2026-07-01-standardized-dialog-primitives.md), not a Sheet.

  import { Unplug } from "lucide-react";
  import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "@/components/ui/dialog";
  import { Button } from "@/components/ui/button";

  interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    pending: boolean;
  }

  export function SignalDisconnectDialog({ open, onOpenChange, onConfirm, pending }: Props) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Signal</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm leading-relaxed text-muted-foreground">
              This removes the linked phone number and recipients from Rigel&apos;s config.
              Notifications stop immediately. The signal-cli-rest bridge stays deployed, so
              you can re-link anytime.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirm} disabled={pending}>
              <Unplug className="size-3.5" />
              {pending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  ```

- [ ] **Step 3: Verify**

  ```
  pnpm --filter web test -- SignalDisconnectDialog
  pnpm --filter web typecheck
  ```

---

## Task 3: Wire Disconnect into `SignalSection`

**Files:**
- Modify: `apps/web/src/panels/settings/SignalSection.tsx`
- Create: `apps/web/src/panels/settings/SignalSection.test.tsx` (this file doesn't exist yet)

- [ ] **Step 1: Write the failing tests**

  ```tsx
  // apps/web/src/panels/settings/SignalSection.test.tsx
  // @vitest-environment jsdom
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
  import type { SettingsDerived } from "./useSettings";

  const mutateAsync = vi.fn(async () => ({ success: true as const, stdout: "", stderr: "" }));
  vi.mock("@/lib/api", () => ({
    useAssistantAction: () => ({ mutateAsync, isPending: false }),
    fetchSignalQR: vi.fn(),
    fetchSignalAccounts: vi.fn(),
    sendSignalTest: vi.fn(),
  }));

  import { SignalSection } from "./SignalSection";

  function derived(over: Partial<SettingsDerived> = {}): SettingsDerived {
    return {
      namespace: "default",
      status: "linked",
      signalNumber: "+15550001111",
      recipients: "+15559998888",
      inbound: false,
      hasSavedNumber: true,
      matrixStatus: "notConnected",
      matrixHomeserverUrl: "",
      matrixUserId: "",
      matrixRoomId: "",
      matrixAllowedSenders: "",
      matrixInbound: false,
      ...over,
    } as SettingsDerived;
  }

  const noop = () => {};

  beforeEach(() => mutateAsync.mockClear());

  describe("SignalSection — disconnect", () => {
    it("shows a Disconnect trigger when linked", () => {
      render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
      expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
    });

    it("does not show Disconnect when not linked", () => {
      render(<SignalSection derived={derived({ status: "ready", signalNumber: "", hasSavedNumber: false })} applying={false} setApplying={noop} />);
      expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
    });

    it("opens a confirm dialog instead of calling setSignal directly", () => {
      render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
      fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
      expect(mutateAsync).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("Cancel closes the dialog without calling setSignal", () => {
      render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
      fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(mutateAsync).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("confirming clears the Signal config via setSignal", async () => {
      render(<SignalSection derived={derived()} applying={false} setApplying={noop} />);
      fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: /^disconnect$/i }));
      await waitFor(() =>
        expect(mutateAsync).toHaveBeenCalledWith({
          action: "setSignal",
          namespace: "default",
          apiUrl: "",
          number: "",
          recipients: "",
          inbound: false,
        }),
      );
    });
  });
  ```

  Run `pnpm --filter web test -- SignalSection` and confirm it fails (no Disconnect trigger exists yet).

- [ ] **Step 2: Add the trigger, dialog, and handler**

  In `apps/web/src/panels/settings/SignalSection.tsx`:

  1. Add imports (alongside the existing lucide-react import on line 8 and the local imports below it):
     ```tsx
     import { Check, ChevronDown, ChevronRight, AlertTriangle, MessageCircle, Unplug } from "lucide-react";
     ```
     and
     ```tsx
     import { SignalDisconnectDialog } from "./SignalDisconnectDialog";
     ```

  2. Add dialog-open state near the other `useState` calls (after `showManifest`, around line 44):
     ```tsx
     const [disconnectOpen, setDisconnectOpen] = useState(false);
     ```

  3. Add a `disconnect()` handler, mirroring `toggleInbound`/`saveRecipients`'s error handling (place it after `toggleInbound`, before `sendTest`, around line 170):
     ```tsx
     async function disconnect() {
       setError(null);
       try {
         await setSignal.mutateAsync({
           action: "setSignal",
           namespace,
           apiUrl: "",
           number: "",
           recipients: "",
           inbound: false,
         });
         setDisconnectOpen(false);
       } catch (err) {
         setError(err instanceof Error ? err.message : String(err));
       }
     }
     ```

  4. In the `status === "linked"` header block (currently `SignalSection.tsx:246-266`), add a Disconnect trigger next to Re-link, styled like Matrix's (`MatrixSection.tsx:150-158`) for visual parity between the two channel cards:
     ```tsx
     {status === "linked" && (
       <div className="flex items-center gap-4">
         <div className="flex items-center gap-2">
           <span className="text-xs font-medium text-foreground">Two-way</span>
           <GreenToggle
             on={inbound}
             onClick={toggleInbound}
             disabled={setSignal.isPending}
             label="Let me text the assistant back"
           />
         </div>
         <Button
           size="sm"
           variant="muted"
           onClick={startLinking}
           disabled={linking}
         >
           Re-link
         </Button>
         <button
           type="button"
           onClick={() => setDisconnectOpen(true)}
           disabled={setSignal.isPending}
           className="flex items-center gap-[7px] transition-opacity hover:opacity-80 disabled:opacity-50"
         >
           <Unplug className="size-[14px] text-destructive" />
           <span className="text-xs font-medium text-destructive">Disconnect</span>
         </button>
       </div>
     )}
     ```

  5. Mount the dialog once, near the end of the returned JSX (right before the closing `</div>` of the card, after the "linked" detail block that ends around line 353):
     ```tsx
     <SignalDisconnectDialog
       open={disconnectOpen}
       onOpenChange={setDisconnectOpen}
       onConfirm={disconnect}
       pending={setSignal.isPending}
     />
     ```

- [ ] **Step 3: Verify**

  ```
  pnpm --filter web test -- SignalSection
  pnpm --filter web test -- SignalDisconnectDialog
  pnpm --filter web typecheck
  ```

---

## Task 4: Full verification pass

- [ ] **Step 1:** `pnpm --filter web typecheck`
- [ ] **Step 2:** `pnpm --filter web test`
- [ ] **Step 3:** `pnpm --filter @rigel/k8s test` (Task 1's regression test lives in this package)
- [ ] **Step 4:** No server route or type changes were needed (this reuses the existing `setSignal` action end-to-end), so `pnpm --filter @rigel/server test` only needs to stay green — run it to confirm nothing else broke:

  ```
  pnpm --filter @rigel/server test
  ```

- [ ] **Step 5:** Manually eyeball the diff against the ticket's three asks:
  - Disconnect action on the connected Signal channel — Task 3.
  - Gated by a confirm dialog (standardized primitives, destructive treatment) — Task 2 (`variant="destructive"` on the confirm button, `Dialog`/`DialogContent`/`DialogHeader`/`DialogBody`/`DialogFooter` from `ui/dialog.tsx`).
  - Tears down the stored config so notifications stop and the channel shows disconnected — Task 3's `disconnect()` clears `signalApiUrl`/`signalNumber`/`signalRecipients`/`signalInbound` via the same `setSignal` path the connect flow writes through; `useSettings`'s live ConfigMap watch flips `status` from `linked` back to `ready` automatically (no extra state plumbing needed).

Do not implement or commit any of this — this is the plan only.
