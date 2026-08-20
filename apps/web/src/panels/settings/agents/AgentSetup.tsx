import { useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChevronLeft,
  faCircleCheck,
  faArrowUpRightFromSquare,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import {
  useSetActiveAgent,
  useSetAgentAuth,
  connectionLabel,
  type AgentAuthMethod,
  type AgentView,
} from "@/lib/api";
import { SECRET_MASK } from "../secretMask";
import { AgentGlyph } from "./agentGlyphs";

const MUTED = "#8C8C95";
const ACCENT = "#3B9BE8";
const ACTIVE = "#5FC9EC";

const METHOD_COPY: Record<
  AgentAuthMethod,
  { title: string; sub: (vendor: string) => string }
> = {
  subscription: {
    title: "Your existing CLI login",
    sub: (v) => `Use your current ${v} subscription session.`,
  },
  apiKey: {
    title: "API key",
    sub: (v) => `Paste your ${v} API key instead.`,
  },
};

export function AgentSetup({
  agent,
  isActive = false,
  locked = false,
  onBack,
}: {
  agent: AgentView;
  isActive?: boolean;
  locked?: boolean;
  onBack: () => void;
}) {
  const comingSoon = agent.status === "comingSoon";
  const save = useSetAgentAuth();
  const setActive = useSetActiveAgent();
  const [method, setMethod] = useState<AgentAuthMethod>(agent.authMethod);
  const [secret, setSecret] = useState("");

  const needsSecret = method === "apiKey";
  // A stored key is never sent back, so an untouched field is empty and there is
  // nothing to save: the key can only be replaced by typing a new one.
  const saveDisabled =
    comingSoon || locked || save.isPending || (needsSecret && !secret.trim());
  const connected = agent.connection === "connected";
  // Guide the two steps off the real status: installed once the CLI is on PATH
  // (notSignedIn means installed-but-unauthenticated), signed in once connected.
  const installed = connected || agent.connection === "notSignedIn";
  const signedIn = connected;

  async function onSave() {
    await save.mutateAsync({
      id: agent.id,
      authMethod: method,
      secret: secret.trim(),
    });
    setSecret("");
  }

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {/* Back */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center self-start transition-opacity hover:opacity-80 text-xs"
        style={{ gap: 6, fontWeight: 500, color: MUTED }}
      >
        <FontAwesomeIcon icon={faChevronLeft} className="size-[15px]" /> Back
      </button>

      {/* Header: mark + name + status pill, then the vendor line */}
      <div className="flex flex-col" style={{ gap: 6 }}>
        <div className="flex items-center justify-between gap-4">
          <div
            className="flex items-center"
            style={{ gap: 10, color: "#FFFFFF" }}
          >
            <AgentGlyph id={agent.id} size={20} />
            <span className="text-lg" style={{ fontWeight: 700, color: "#FFFFFF" }}>
              {agent.label}
            </span>
          </div>
          <StatusPill connection={agent.connection} />
        </div>
      </div>

      {/* Step 1 — Install */}
      <StepCard
        n={1}
        done={installed}
        heading={`Install ${agent.label}`}
        desc={
          installed
            ? `The ${agent.label} CLI was found on this machine.`
            : `The ${agent.label} CLI isn't installed on this machine yet. Install it, then reopen this panel.`
        }
      >
        <a
          href={agent.installUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center self-start rounded-lg border border-white/[0.08] transition-colors hover:bg-white/[0.04] text-xs"
          style={{
            gap: 7,
            padding: "8px 14px",
            fontWeight: 600,
            color: "#4FB0F2",
          }}
        >
          {agent.installLabel}
          <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="size-[14px]" />
        </a>
      </StepCard>

      {/* Step 2 — Authenticate */}
      <StepCard
        n={2}
        done={signedIn}
        heading="Authenticate"
        desc={
          signedIn
            ? `Rigel is authenticated with ${agent.label}.`
            : `Choose how Rigel authenticates with ${agent.label}.`
        }
      >
        <div className="flex flex-col" style={{ gap: 8 }}>
          {agent.authMethods.map((m) => {
            const selected = method === m;
            const copy = METHOD_COPY[m];
            return (
              <div key={m}>
                <button
                  type="button"
                  disabled={comingSoon || locked}
                  onClick={() => setMethod(m)}
                  className="flex w-full items-center rounded-lg border text-left transition-colors disabled:cursor-not-allowed"
                  style={{
                    gap: 11,
                    padding: "11px 13px",
                    borderColor: selected ? ACCENT : "rgba(255,255,255,0.08)",
                    background: selected
                      ? "rgba(59,155,232,0.09)"
                      : "transparent",
                    opacity: comingSoon ? 0.6 : 1,
                  }}
                >
                  <Radio selected={selected} />
                  <span className="flex flex-col" style={{ gap: 2 }}>
                    <span
                      className="text-xs"
                      style={{
                        fontWeight: 600,
                        color: "#FFFFFF",
                      }}
                    >
                      {copy.title}
                    </span>
                    <span className="text-xs" style={{ color: MUTED }}>
                      {copy.sub(agent.vendor)}
                    </span>
                  </span>
                </button>

                {needsSecret && selected && (
                  <>
                    <input
                      type="password"
                      aria-label={`${agent.label} API key`}
                      value={secret}
                      disabled={comingSoon || locked}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder={
                        agent.apiKeySet
                          ? SECRET_MASK
                          : agent.id === "claude"
                            ? "sk-ant-…"
                            : "API key"
                      }
                      className="mt-2 w-full rounded-lg border border-white/[0.08] bg-black/20 font-mono outline-none focus:border-[#3B9BE8] text-xs disabled:cursor-not-allowed disabled:opacity-60"
                      style={{
                        padding: "9px 12px",
                        color: "#FFFFFF",
                      }}
                    />
                    {agent.apiKeySet && (
                      <p className="mt-1.5 text-xs" style={{ color: MUTED }}>
                        A key is saved. Type a new one to replace it.
                      </p>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </StepCard>

      {comingSoon && (
        <p className="text-xs" style={{ color: MUTED }}>
          This agent isn't connectable yet. We're building its runner. For now,
          use a connected agent.
        </p>
      )}

      {save.isError && (
        <p className="text-xs" style={{ color: "var(--destructive)" }}>
          {save.error.message}
        </p>
      )}
      {setActive.isError && (
        <p className="text-xs" style={{ color: "var(--destructive)" }}>
          {setActive.error.message}
        </p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-end" style={{ gap: 8 }}>
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg transition-colors hover:bg-white/[0.04] text-xs"
          style={{
            padding: "9px 16px",
            fontWeight: 600,
            color: MUTED,
          }}
        >
          Cancel
        </button>

        {/* In-use selection — only when the agent is connected. The one currently
            in use shows a non-interactive indicator; others get the "Use this agent"
            button. */}
        {connected &&
          (isActive ? (
            <span
              className="inline-flex items-center text-xs"
              style={{
                gap: 7,
                padding: "13px 20px",
                fontWeight: 700,
                color: ACTIVE,
              }}
            >
              <FontAwesomeIcon icon={faCircleCheck} className="size-[15px]" /> In use
            </span>
          ) : (
            <button
              type="button"
              disabled={setActive.isPending}
              onClick={() => setActive.mutate(agent.id)}
              className="inline-flex items-center rounded-[10px] transition-colors hover:bg-[rgba(95,201,236,0.08)] disabled:opacity-40 text-xs"
              style={{
                gap: 7,
                padding: "13px 20px",
                fontWeight: 700,
                color: ACTIVE,
                border: `1px solid ${ACTIVE}`,
              }}
            >
              <FontAwesomeIcon icon={faCircleCheck} className="size-[15px]" />{" "}
              {setActive.isPending ? "Switching…" : "Use this agent"}
            </button>
          ))}

        <button
          type="button"
          disabled={saveDisabled}
          onClick={onSave}
          className="rounded-lg transition-opacity disabled:opacity-40 text-xs"
          style={{
            padding: "9px 22px",
            fontWeight: 700,
            color: "#06151C",
            background: "#5FC9EC",
          }}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/**
 * Status pill reflecting the real connection state: green "Connected", amber
 * "Not installed" / "Not signed in", or a muted "Coming soon".
 */
function StatusPill({ connection }: { connection: AgentView["connection"] }) {
  if (connection === "comingSoon") {
    return (
      <span
        className="inline-flex shrink-0 items-center rounded-full text-xs"
        style={{
          padding: "5px 11px",
          fontWeight: 600,
          color: MUTED,
          background: "rgba(255,255,255,0.06)",
        }}
      >
        Coming soon
      </span>
    );
  }
  // Green when connected/usable, amber for the not-installed / not-signed-in gates.
  const color = connection === "connected" ? "var(--status-running)" : "var(--status-pending)";
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full"
      style={{
        gap: 6,
        padding: "5px 11px",
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      <span className="text-xs" style={{ fontWeight: 600, color }}>
        {connectionLabel(connection)}
      </span>
    </span>
  );
}

/** A numbered step card: badge + heading, description, then its children. When
 *  `done`, the number badge is replaced by a green check to show the step is met. */
function StepCard({
  n,
  heading,
  desc,
  children,
  done = false,
}: {
  n: number;
  heading: string;
  desc: string;
  children: ReactNode;
  done?: boolean;
}) {
  return (
    <div
      className="flex flex-col rounded-xl border border-white/[0.08]"
      style={{ gap: 12, padding: 16, background: "#161618" }}
    >
      <div className="flex items-center" style={{ gap: 10 }}>
        {done ? (
          <span
            className="inline-flex items-center justify-center"
            style={{ width: 22, height: 22, color: "var(--status-running)" }}
          >
            <FontAwesomeIcon icon={faCircleCheck} className="size-[18px]" />
          </span>
        ) : (
          <span
            className="inline-flex items-center justify-center rounded-full text-xs"
            style={{
              width: 22,
              height: 22,
              fontWeight: 700,
              color: "#FFFFFF",
              background: "rgba(255,255,255,0.08)",
            }}
          >
            {n}
          </span>
        )}
        <span className="text-sm" style={{ fontWeight: 700, color: "#FFFFFF" }}>
          {heading}
        </span>
      </div>
      <p className="text-xs" style={{ lineHeight: 1.5, color: MUTED }}>{desc}</p>
      {children}
    </div>
  );
}

/** Radio dot: blue ring + filled center when selected, gray ring otherwise. */
function Radio({ selected }: { selected: boolean }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: 18,
        height: 18,
        border: `2px solid ${selected ? ACCENT : "#54545C"}`,
      }}
    >
      {selected && (
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: ACCENT,
          }}
        />
      )}
    </span>
  );
}
