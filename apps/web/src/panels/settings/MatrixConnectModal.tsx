// Matrix connect wizard. Path 1 picks where the homeserver lives:
//   A) an existing homeserver (the happy default for self-hosters)
//   B) a public homeserver (matrix.org) — honest privacy caveat
// Step 2 takes the homeserver URL + bot auth (paste a token OR log in) +
// allowed senders, then provisions an unencrypted room and saves via setMatrix.
// The terminal "first contact" step tells the user to accept the room invite.
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { parseAllowedSenders } from "@rigel/k8s";
import { matrixLogin, matrixValidate, matrixCreateRoom, useAssistantAction } from "@/lib/api";

type Path = "A" | "B";
type AuthMode = "token" | "login";
type Step = "path" | "details" | "firstContact";

export function MatrixConnectModal({
  open,
  onClose,
  namespace,
  defaultAllowed,
}: {
  open: boolean;
  onClose: () => void;
  namespace: string;
  defaultAllowed?: string;
}) {
  const setMatrix = useAssistantAction();
  const [step, setStep] = useState<Step>("path");
  const [path, setPath] = useState<Path | null>(null);
  const [homeserver, setHomeserver] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("token");
  const [token, setToken] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [allowed, setAllowed] = useState(defaultAllowed ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("path");
    setPath(null);
    setHomeserver("");
    setAuthMode("token");
    setToken("");
    setUser("");
    setPassword("");
    setError(null);
    setBusy(false);
  }

  function choosePath(p: Path) {
    setPath(p);
    setHomeserver(p === "B" ? "https://matrix.org" : "");
    setStep("details");
  }

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      let accessToken: string;
      let userId: string;
      if (authMode === "login") {
        const r = await matrixLogin(homeserver, user, password);
        accessToken = r.accessToken;
        userId = r.userId;
      } else {
        accessToken = token.trim();
        const r = await matrixValidate(homeserver, accessToken);
        userId = r.userId;
      }
      const senders = parseAllowedSenders(allowed);
      const { roomId } = await matrixCreateRoom(homeserver, accessToken, "Rigel", senders);
      await setMatrix.mutateAsync({
        action: "setMatrix",
        namespace,
        matrixHomeserverUrl: homeserver,
        matrixUserId: userId,
        matrixAccessToken: accessToken,
        matrixRoomId: roomId,
        matrixAllowedSenders: senders.join(", "),
        matrixInbound: true,
      });
      setStep("firstContact");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    onClose();
    reset();
  }

  return (
    <Modal open={open} onOpenChange={(o) => (o ? undefined : close())} title="Connect Matrix">
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="select-text">{error}</span>
        </div>
      )}

      {step === "path" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Where should Rigel&apos;s Matrix live?</p>
          <Button size="sm" className="w-full justify-start" onClick={() => choosePath("A")}>
            I already have a homeserver
          </Button>
          <Button size="sm" variant="outline" className="w-full justify-start" onClick={() => choosePath("B")}>
            Use a public homeserver (matrix.org)
          </Button>
        </div>
      )}

      {step === "details" && (
        <div className="space-y-3">
          {path === "B" && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              The room is unencrypted, so the public host can read it. Use a homeserver you own for full privacy.
            </p>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Homeserver URL</span>
            <input
              aria-label="Homeserver URL"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              placeholder="https://matrix.example.com"
              value={homeserver}
              onChange={(e) => setHomeserver(e.target.value)}
            />
          </label>

          <div className="inline-flex rounded-md border p-0.5 text-xs">
            <button
              className={`rounded px-2 py-0.5 ${authMode === "token" ? "bg-muted font-medium" : "text-muted-foreground"}`}
              onClick={() => setAuthMode("token")}
            >
              Paste a token
            </button>
            <button
              className={`rounded px-2 py-0.5 ${authMode === "login" ? "bg-muted font-medium" : "text-muted-foreground"}`}
              onClick={() => setAuthMode("login")}
            >
              Log in
            </button>
          </div>

          {authMode === "token" ? (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Bot access token</span>
              <input
                aria-label="Access token"
                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          ) : (
            <div className="space-y-2">
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Bot username</span>
                <input
                  aria-label="Username"
                  className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Bot password</span>
                <input
                  aria-label="Password"
                  type="password"
                  className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </div>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Allowed senders (comma-separated Matrix IDs)</span>
            <input
              aria-label="Allowed senders"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              placeholder="@you:example.com"
              value={allowed}
              onChange={(e) => setAllowed(e.target.value)}
            />
          </label>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setStep("path")} disabled={busy}>
              Back
            </Button>
            <Button size="sm" onClick={connect} disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </div>
      )}

      {step === "firstContact" && (
        <div className="space-y-3">
          <p className="text-sm">Rigel created a room and invited you.</p>
          <p className="text-xs text-muted-foreground">
            Open your Matrix client, accept the invite, and say hi. Rigel will reply from the cluster.
          </p>
          <Button size="sm" onClick={close}>
            Done
          </Button>
        </div>
      )}
    </Modal>
  );
}
