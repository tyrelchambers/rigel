// Matrix connect wizard — a faithful build of the Pencil "Matrix Wizard" frames
// (clankerlocal.pen). The flow is a real multi-step wizard:
//   Step 1 "where" (egncz)        — pick where the homeserver lives.
//   Step 2 "details" (EQobU/cWrYd/wf6XS)
//       Path A: existing homeserver — URL + [Paste access token | Log in] + allowed senders.
//       Path B: public homeserver (matrix.org) — bot account + allowed senders + privacy callout.
//   Step 3 "first contact" (tXkqG) — say hello, with the live handshake tracker.
//   Connected success (sfqdY)      — summary table + channel toggle.
//   Error (rsCnp / Nv2aQ)          — auth failed / homeserver unreachable.
//
// The CONNECT CONTRACT is unchanged from the prior build:
//   token mode → matrixValidate → matrixCreateRoom → setMatrix
//   login mode → matrixLogin    → matrixCreateRoom → setMatrix
//   Connect is gated on a non-empty allowed-senders list (a critical fix).
import { useState } from "react";
import {
  MessageSquare,
  Server,
  Globe,
  Boxes,
  KeyRound,
  LogIn,
  Lock,
  Plus,
  Copy,
  Send,
  Check,
  ArrowRight,
  RefreshCw,
  WifiOff,
  ShieldAlert,
  CircleCheckBig,
  Circle,
  Loader2,
  Terminal,
  AlertTriangle,
} from "lucide-react";
import { parseAllowedSenders } from "@rigel/k8s";
import { matrixLogin, matrixValidate, matrixCreateRoom, useAssistantAction } from "@/lib/api";
import { useCopyToClipboard } from "@/lib/useCopyToClipboard";
import {
  WizardShell,
  WizardBody,
  WizardIntro,
  WizardInput,
  WizardFooter,
  OptionCard,
  SegmentedToggle,
  GreenToggle,
  BackButton,
  PrimaryButton,
  SUB,
  LABEL,
  CAPTION,
  STEP_TXT,
} from "./MatrixWizardParts";

type Path = "A" | "B";
type AuthMode = "token" | "login";
type View = "where" | "details" | "firstContact" | "connected";

interface ErrInfo {
  title: string;
  icon: React.ReactNode;
  lead: string;
  cause: string;
  detail: string;
}

/** Map a thrown connect error to one of the design's error frames. */
function classifyError(message: string, homeserver: string): ErrInfo {
  const m = message.toLowerCase();
  if (/forbidden|unauthor|invalid.*token|token.*invalid|m_forbidden|access token|password|login|auth/.test(m)) {
    return {
      title: "Authentication failed",
      icon: <Lock className="size-[17px]" />,
      lead: "Rigel couldn't sign in as @rigel.",
      cause:
        "The homeserver rejected the credentials. Generate a fresh access token, or switch to username and password.",
      detail: message,
    };
  }
  if (/timeout|dial|econn|enotfound|unreachable|network|fetch failed|getaddrinfo|refused/.test(m)) {
    return {
      title: "Homeserver unreachable",
      icon: <WifiOff className="size-[17px]" />,
      lead: "Rigel can't reach the homeserver.",
      cause: `${homeserver || "The homeserver"} didn't respond. Check the URL and that the server is up on your tailnet.`,
      detail: message,
    };
  }
  return {
    title: "Couldn't connect",
    icon: <AlertTriangle className="size-[17px]" />,
    lead: "Rigel couldn't finish connecting.",
    cause: "The homeserver returned an unexpected error. Review the details below and try again.",
    detail: message,
  };
}

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
  const { copy } = useCopyToClipboard();

  const [view, setView] = useState<View>("where");
  const [selected, setSelected] = useState<Path | null>(null);
  const [path, setPath] = useState<Path>("A");
  const [homeserver, setHomeserver] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("token");
  const [token, setToken] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [allowed, setAllowed] = useState(defaultAllowed ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedUser, setConnectedUser] = useState("");

  const senderList = parseAllowedSenders(allowed);
  const allowedSendersEmpty = senderList.length === 0;
  const botHandle = connectedUser || "@rigel:example.com";

  function reset() {
    setView("where");
    setSelected(null);
    setPath("A");
    setHomeserver("");
    setAuthMode("token");
    setToken("");
    setUser("");
    setPassword("");
    setAllowed(defaultAllowed ?? "");
    setBusy(false);
    setError(null);
    setConnectedUser("");
  }

  function close() {
    onClose();
    reset();
  }

  function goDetails() {
    if (!selected) return;
    setPath(selected);
    // Path B is the public-homeserver branch: matrix.org + a bot account (login).
    setHomeserver(selected === "B" ? "https://matrix.org" : "");
    setAuthMode(selected === "B" ? "login" : "token");
    setView("details");
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
      setConnectedUser(userId);
      setView("firstContact");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // ── error screen (terminal-style shell) ──────────────────────────────────
  if (error) {
    const info = classifyError(error, homeserver);
    return (
      <WizardShell
        open={open}
        onOpenChange={(o) => (o ? undefined : close())}
        title={info.title}
        icon={info.icon}
        iconTone="red"
        footer={
          <WizardFooter
            left={<BackButton onClick={() => setError(null)} />}
            right={
              <PrimaryButton
                label="Retry"
                icon={<RefreshCw className="size-[15px]" />}
                onClick={connect}
                busy={busy}
              />
            }
          />
        }
      >
        <WizardBody gap={13}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#FFFFFF" }}>{info.lead}</span>
          <span style={{ fontSize: 13, color: SUB, lineHeight: 1.5 }}>{info.cause}</span>
          <div
            className="flex items-start gap-2.5 rounded-lg"
            style={{ background: "var(--surface-sunken)", border: "1px solid rgba(255,255,255,0.07)", padding: "10px 12px" }}
          >
            <Terminal className="mt-0.5 size-[13px] shrink-0" style={{ color: CAPTION }} />
            <span className="select-text font-mono" style={{ fontSize: 11.5, color: "#B6B6BE", lineHeight: 1.4 }}>
              {info.detail}
            </span>
          </div>
        </WizardBody>
      </WizardShell>
    );
  }

  // ── connecting (generic loading) ─────────────────────────────────────────
  if (busy && view === "details") {
    return (
      <WizardShell
        open={open}
        onOpenChange={(o) => (o ? undefined : close())}
        title="Set up Matrix"
        icon={<MessageSquare className="size-[17px]" />}
        progress={2 / 3}
        step={2}
      >
        <WizardBody>
          <div className="flex flex-col items-center justify-center gap-4 py-10">
            <Loader2 className="size-7 animate-spin" style={{ color: "var(--accent-primary)" }} />
            <div className="flex flex-col items-center gap-1">
              <span style={{ fontSize: 14, fontWeight: 600, color: "#FFFFFF" }}>Connecting…</span>
              <span className="font-mono" style={{ fontSize: 12.5, color: SUB }}>
                {homeserver}
              </span>
            </div>
          </div>
        </WizardBody>
      </WizardShell>
    );
  }

  // ── Step 1: where ────────────────────────────────────────────────────────
  if (view === "where") {
    return (
      <WizardShell
        open={open}
        onOpenChange={(o) => (o ? undefined : close())}
        title="Set up Matrix"
        icon={<MessageSquare className="size-[17px]" />}
        progress={1 / 3}
        step={1}
        footer={
          <WizardFooter
            left={<BackButton label="Cancel" chevron={false} onClick={close} />}
            right={
              <PrimaryButton
                label="Continue"
                icon={<ArrowRight className="size-4" />}
                onClick={goDetails}
                disabled={!selected}
              />
            }
          />
        }
      >
        <WizardBody>
          <WizardIntro
            lead="Where should Rigel's Matrix live?"
            sub="Rigel dials out to a Matrix homeserver as the @rigel bot, and you message it from Element. Pick where that homeserver runs."
          />
          <div className="flex flex-col gap-3">
            <OptionCard
              tone="green"
              tag="MOST PRIVATE"
              title="I already have a homeserver"
              desc="Point Rigel at a Synapse or Dendrite you already run."
              icon={<Server className="size-5" />}
              selected={selected === "A"}
              onClick={() => setSelected("A")}
            />
            <OptionCard
              tone="accent"
              tag="EASIEST"
              title="Use a public homeserver (matrix.org)"
              desc="Connect through shared infrastructure. Up and running in a minute."
              icon={<Globe className="size-5" />}
              selected={selected === "B"}
              onClick={() => setSelected("B")}
            />
            <OptionCard
              tone="amber"
              tag="ADVANCED"
              title="Install Matrix in my cluster"
              desc="Rigel deploys Synapse into your cluster and wires up the bot."
              icon={<Boxes className="size-5" />}
              disabled
              badge={
                <span className="self-start font-mono" style={{ fontSize: 10.5, letterSpacing: 0.6, color: CAPTION }}>
                  Coming soon
                </span>
              }
            />
          </div>
        </WizardBody>
      </WizardShell>
    );
  }

  // ── Step 2: details ──────────────────────────────────────────────────────
  if (view === "details") {
    const isPublic = path === "B";
    const footer = (
      <WizardFooter
        left={<BackButton onClick={() => setView("where")} />}
        right={
          <PrimaryButton
            label="Continue"
            icon={<ArrowRight className="size-4" />}
            onClick={connect}
            disabled={allowedSendersEmpty}
            busy={busy}
          />
        }
      />
    );
    return (
      <WizardShell
        open={open}
        onOpenChange={(o) => (o ? undefined : close())}
        title="Set up Matrix"
        icon={<MessageSquare className="size-[17px]" />}
        progress={2 / 3}
        step={2}
        footer={footer}
      >
        <WizardBody>
          {isPublic ? (
            <WizardIntro
              lead="Use a public homeserver"
              sub="Quickest way to try Rigel over Matrix. You'll create a bot account on a shared server."
            />
          ) : (
            <WizardIntro
              lead="Connect your homeserver"
              sub="Rigel signs in as @rigel and only answers people you explicitly allow."
            />
          )}

          <WizardInput
            label={isPublic ? "Homeserver" : "Homeserver URL"}
            value={homeserver}
            onChange={setHomeserver}
            placeholder="https://matrix.example.com"
          />

          {!isPublic && (
            <div className="flex flex-col gap-2">
              <span style={{ fontSize: 12.5, fontWeight: 500, color: LABEL }}>Bot sign-in</span>
              <SegmentedToggle<AuthMode>
                value={authMode}
                onChange={setAuthMode}
                options={[
                  { id: "token", label: "Paste access token", icon: <KeyRound className="size-3.5" /> },
                  { id: "login", label: "Log in", icon: <LogIn className="size-3.5" /> },
                ]}
              />
              <span style={{ fontSize: 11.5, color: CAPTION, lineHeight: 1.4 }}>
                {authMode === "token"
                  ? "Use a token you already created — best for SSO accounts or a scoped, dedicated bot token. Rigel never sees your password."
                  : "Rigel signs in with these once, stores the access token, and forgets the password."}
              </span>
            </div>
          )}

          {isPublic || authMode === "login" ? (
            <>
              <WizardInput
                label="Bot username"
                value={user}
                onChange={setUser}
                placeholder={isPublic ? "rigel-bot" : "@rigel:matrix.example.com"}
              />
              <WizardInput
                label={isPublic ? "Bot password" : "Password"}
                value={password}
                onChange={setPassword}
                type="password"
                mono={false}
                trailing={isPublic ? undefined : <Lock className="size-[15px]" />}
              />
            </>
          ) : (
            <WizardInput
              label="Access token"
              value={token}
              onChange={setToken}
              placeholder="syt_…"
              trailing={<KeyRound className="size-[15px]" />}
            />
          )}

          <WizardInput
            label="Allowed senders"
            value={allowed}
            onChange={setAllowed}
            placeholder={isPublic ? "@you:matrix.org" : "@you:example.com"}
            trailing={<Plus className="size-[15px]" />}
            hint="Only these Matrix IDs can command Rigel."
          />

          {isPublic && (
            <div
              className="flex items-start gap-[11px] rounded-[10px]"
              style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.19)", padding: 13 }}
            >
              <ShieldAlert className="size-[18px] shrink-0" style={{ color: "var(--status-pending)" }} />
              <div className="flex flex-col gap-[3px]">
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "#F4C77A" }}>This server isn't yours</span>
                <span style={{ fontSize: 12.5, color: "#C9A56A", lineHeight: 1.45 }}>
                  On a homeserver you don't run, your cluster chatter isn't private to you. Use your own or an
                  in-cluster homeserver for sensitive clusters.
                </span>
              </div>
            </div>
          )}
        </WizardBody>
      </WizardShell>
    );
  }

  // ── Step 3: first contact ────────────────────────────────────────────────
  if (view === "firstContact") {
    const steps = [
      "Open Element on your phone",
      "Start a new chat with @rigel",
      'Send "status" — Rigel replies right in the room',
    ];
    return (
      <WizardShell
        open={open}
        onOpenChange={(o) => (o ? undefined : close())}
        title="Set up Matrix"
        icon={<MessageSquare className="size-[17px]" />}
        progress={1}
        step={3}
        footer={
          <WizardFooter
            left={<BackButton onClick={() => setView("details")} />}
            right={
              <PrimaryButton
                label="Finish"
                icon={<Check className="size-4" />}
                onClick={() => setView("connected")}
              />
            }
          />
        }
      >
        <WizardBody>
          <WizardIntro
            lead="Say hello to Rigel"
            sub="Open Element, start a chat with the bot, and send any message to confirm the channel works."
          />

          {/* Bot handle + copy */}
          <div
            className="flex items-center justify-between rounded-[10px]"
            style={{ background: "var(--surface-sunken)", border: "1px solid rgba(255,255,255,0.07)", padding: "12px 14px" }}
          >
            <div className="flex flex-col gap-[5px]">
              <span className="font-mono" style={{ fontSize: 10.5, letterSpacing: 0.8, color: CAPTION }}>
                MESSAGE THIS BOT
              </span>
              <span className="select-text font-mono" style={{ fontSize: 13.5, color: "#FFFFFF" }}>
                {botHandle}
              </span>
            </div>
            <button
              type="button"
              aria-label="Copy bot handle"
              onClick={() => copy(botHandle)}
              className="flex size-[30px] items-center justify-center rounded-lg transition-colors hover:bg-white/[0.08]"
              style={{ background: "rgba(255,255,255,0.05)" }}
            >
              <Copy className="size-[15px]" style={{ color: SUB }} />
            </button>
          </div>

          {/* Numbered steps */}
          <div className="flex flex-col gap-[11px]">
            {steps.map((s, i) => (
              <div key={i} className="flex items-center gap-[11px]">
                <span
                  className="flex size-[22px] shrink-0 items-center justify-center rounded-full font-mono"
                  style={{ background: "rgba(255,255,255,0.06)", fontSize: 11, color: STEP_TXT }}
                >
                  {i + 1}
                </span>
                <span style={{ fontSize: 13, color: STEP_TXT }}>{s}</span>
              </div>
            ))}
          </div>

          {/* Live handshake tracker.
              TODO(phase-1): no Matrix message-poll endpoint exists yet, so only the
              first row goes live after createRoom. "Message received" / "Rigel replied"
              stay pending until a room-poll signal source lands. The three-row tracker
              UI itself matches the design (frame tXkqG) exactly. */}
          <div
            className="flex flex-col gap-1 rounded-[12px]"
            style={{ background: "#17181B", border: "1px solid rgba(255,255,255,0.07)", padding: "8px 16px" }}
          >
            <TrackerRow
              state="active"
              title="Waiting for your message"
              sub="Listening in the matrix room"
              right={<span className="font-mono" style={{ fontSize: 11, color: "var(--accent-primary)" }}>Live</span>}
            />
            <TrackerRow state="pending" title="Message received" sub="Rigel sees your text" />
            <TrackerRow state="pending" title="Rigel replied" sub="Reply delivered to Element" />
          </div>

          {/* Send a test (no Matrix test-send endpoint in Phase 1). */}
          <button
            type="button"
            onClick={() => {
              /* TODO(phase-1): wire to a Matrix test-send endpoint when it exists. */
            }}
            className="flex w-full items-center justify-center gap-2 rounded-[9px] transition-colors hover:bg-white/[0.08]"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", padding: "11px 0" }}
          >
            <Send className="size-[15px]" style={{ color: STEP_TXT }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: "#FFFFFF" }}>Send a test message from Rigel</span>
          </button>
        </WizardBody>
      </WizardShell>
    );
  }

  // ── Connected success ────────────────────────────────────────────────────
  const summary: { k: string; v: string }[] = [
    { k: "Homeserver", v: homeserver.replace(/^https?:\/\//, "") || "matrix.example.com" },
    { k: "Bot", v: botHandle },
    { k: "Allowed senders", v: senderList.join(", ") || "@you:example.com" },
  ];
  return (
    <WizardShell
      open={open}
      onOpenChange={(o) => (o ? undefined : close())}
      title="Matrix connected"
      icon={<CircleCheckBig className="size-[17px]" />}
      iconTone="green"
      footer={
        <WizardFooter
          left={
            <BackButton
              label="Send a test"
              chevron={false}
              icon={<Send className="size-[15px]" />}
              onClick={() => {
                /* TODO(phase-1): wire to a Matrix test-send endpoint when it exists. */
              }}
            />
          }
          right={<PrimaryButton label="Done" icon={<Check className="size-4" />} onClick={close} />}
        />
      }
    >
      <WizardBody gap={16}>
        <span style={{ fontSize: 13, color: SUB, lineHeight: 1.5 }}>
          Rigel is reachable over Matrix. Message the bot from Element any time to query or act on your cluster.
        </span>

        <div
          className="flex flex-col rounded-[12px]"
          style={{ background: "#17181B", border: "1px solid rgba(255,255,255,0.07)", padding: "4px 16px" }}
        >
          {summary.map((r, i) => (
            <div key={r.k}>
              {i > 0 && <div style={{ height: 1, background: "rgba(255,255,255,0.05)" }} />}
              <div className="flex items-center justify-between gap-4" style={{ padding: "12px 0" }}>
                <span style={{ fontSize: 13, color: SUB }}>{r.k}</span>
                <span className="select-text font-mono" style={{ fontSize: 12.5, color: "#FFFFFF" }}>
                  {r.v}
                </span>
              </div>
            </div>
          ))}
          <div style={{ height: 1, background: "rgba(255,255,255,0.05)" }} />
          <div className="flex items-center justify-between gap-4" style={{ padding: "12px 0" }}>
            <div className="flex flex-col gap-0.5">
              <span style={{ fontSize: 13, fontWeight: 500, color: "#FFFFFF" }}>Channel</span>
              <span style={{ fontSize: 11.5, color: SUB }}>Enabled and listening</span>
            </div>
            <GreenToggle on label="Channel enabled" />
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <MessageSquare className="size-[15px] shrink-0" style={{ color: "var(--accent-primary)" }} />
          <span style={{ fontSize: 13, color: STEP_TXT }}>
            Message @rigel from Element to query your cluster.
          </span>
        </div>
      </WizardBody>
    </WizardShell>
  );
}

/** One row of the first-contact live handshake tracker. */
function TrackerRow({
  state,
  title,
  sub,
  right,
}: {
  state: "active" | "pending" | "done";
  title: string;
  sub: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3" style={{ padding: "3px 0" }}>
      <div className="flex items-center gap-3">
        <span className="flex size-[22px] shrink-0 items-center justify-center">
          {state === "active" ? (
            <Loader2 className="size-[18px] animate-spin" style={{ color: "var(--accent-primary)" }} />
          ) : state === "done" ? (
            <CircleCheckBig className="size-[18px]" style={{ color: "var(--status-running)" }} />
          ) : (
            <Circle className="size-[18px]" style={{ color: "#48484F" }} />
          )}
        </span>
        <div className="flex flex-col gap-0.5">
          <span style={{ fontSize: 13.5, fontWeight: 500, color: "#FFFFFF" }}>{title}</span>
          <span style={{ fontSize: 12, color: SUB }}>{sub}</span>
        </div>
      </div>
      {right ?? <span className="font-mono" style={{ fontSize: 11, color: CAPTION }}>—</span>}
    </div>
  );
}
