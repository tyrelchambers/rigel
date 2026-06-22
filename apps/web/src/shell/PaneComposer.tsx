/**
 * PaneComposer — the chat composer chrome for ChatPane.
 *
 * Composer chrome matching ChatComposer.swift:
 * - Rounded container with a multiline field.
 * - Footer: model picker + "</> commands" chip on the left; send/stop on the right.
 * - `/` opens a command typeahead; `@` opens a resource mention picker
 *   (↑/↓ to move, Enter/Tab to pick, Esc to dismiss).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Layers, Server, Check, ChevronDown, Search } from "lucide-react";
import {
  effortName,
  modelLabel,
  modelName,
  type ModelConfig,
} from "@/panels/chat/composerModel";
import type { AgentId } from "@/lib/api";
import { AgentGlyph } from "@/panels/settings/agents/agentGlyphs";
import {
  commandDisplay,
  commandInsertion,
  type ChatCommandSpec,
} from "@/panels/chat/chatCommands";
import {
  MENTION_KIND_LABEL,
  type MentionCandidate,
  type MentionKind,
} from "@/panels/chat/mentions";
import {
  computeTrigger,
  commandRest,
  type ComposerTrigger,
} from "./composerTriggerLogic";

// ── PaneComposer ─────────────────────────────────────────────────────────────

const PLACEHOLDER = "Ask Rigel…  (/ for commands, @ to mention a resource)";
const PLACEHOLDER_UNCONFIGURED = "Connect an agent in Settings to chat";
const LINE_HEIGHT = 20;
const MIN_LINES = 3;
const MAX_LINES = 14;

interface PaneComposerProps {
  ref?: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  /** True when the active agent isn't connected — drives the disabled placeholder. */
  notConfigured?: boolean;
  /** The active agent id — drives the chip glyph + the pretty/raw model label. */
  agentId?: AgentId;
  /** The active agent's selectable model ids (from GET /api/agents/<id>/models). */
  models: string[];
  /** The active agent's reasoning-effort levels (Claude-only; empty otherwise). */
  efforts: string[];
  /** The active agent's current selection, or null while models are unknown. */
  modelConfig: ModelConfig | null;
  onModelConfig: (c: ModelConfig) => void;
  mentionCandidates: MentionCandidate[];
}

/** Show a search box for long model lists (always for opencode's provider/model). */
const MODEL_SEARCH_THRESHOLD = 8;

const MENTION_ICON: Record<MentionKind, typeof Box> = {
  pod: Box,
  deployment: Layers,
  node: Server,
};

/**
 * Composer chrome matching ChatComposer.swift:
 * - Rounded container with a multiline field.
 * - Footer: model picker + "</> commands" chip on the left; send/stop on the right.
 * - `/` opens a command typeahead; `@` opens a resource mention picker
 *   (↑/↓ to move, Enter/Tab to pick, Esc to dismiss).
 */
export function PaneComposer({
  ref,
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  disabled,
  notConfigured,
  agentId,
  models,
  efforts,
  modelConfig,
  onModelConfig,
  mentionCandidates,
}: PaneComposerProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = (ref ?? internalRef) as React.RefObject<HTMLTextAreaElement>;
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");

  // Reset the model search whenever the picker closes or the agent changes.
  useEffect(() => {
    if (!modelOpen) setModelQuery("");
  }, [modelOpen]);
  useEffect(() => {
    setModelQuery("");
  }, [agentId]);

  // Show the filter box for long lists (always for opencode's provider/model set).
  const showModelSearch = agentId === "opencode" || models.length > MODEL_SEARCH_THRESHOLD;
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.toLowerCase().includes(q));
  }, [models, modelQuery]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const min = LINE_HEIGHT * MIN_LINES;
    const max = LINE_HEIGHT * MAX_LINES;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`;
  }, [value, textareaRef]);

  // Active "/" (leading) or "@<token>" trigger from the text up to the caret.
  const trigger = useMemo<ComposerTrigger | null>(
    () => computeTrigger(value, caret, mentionCandidates),
    [value, caret, mentionCandidates],
  );

  const triggerKey = trigger ? `${trigger.kind}:${trigger.query}` : "";
  useEffect(() => {
    setSel(0);
    setDismissed(false);
  }, [triggerKey]);

  const popoverOpen = trigger !== null && !dismissed;

  function syncCaret() {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }
  function setCaretAt(p: number) {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(p, p);
        setCaret(p);
      }
    });
  }

  function pickCommand(spec: ChatCommandSpec) {
    const rest = commandRest(value);
    const ins = commandInsertion(spec);
    onChange(ins + rest);
    setCaretAt(ins.length);
  }
  function pickMention(c: MentionCandidate) {
    if (trigger?.kind !== "mention") return;
    const ins = `${c.name} `;
    onChange(value.slice(0, trigger.start) + ins + value.slice(caret));
    setCaretAt(trigger.start + ins.length);
  }
  function selectCurrent() {
    if (!trigger) return;
    if (trigger.kind === "command") pickCommand(trigger.items[sel]);
    else pickMention(trigger.items[sel]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (popoverOpen && trigger) {
      const n = trigger.items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % n);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s - 1 + n) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectCurrent();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Escape") {
      if (modelOpen) {
        e.preventDefault();
        setModelOpen(false);
        return;
      }
      if (isStreaming) {
        e.preventDefault();
        onStop();
      }
      return;
    }
    if (e.key === "Enter") {
      if (e.shiftKey) return;
      e.preventDefault();
      onSend();
    }
  }

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div
      style={{
        padding: "8px 12px 10px",
        borderTop: "1px solid #26272B",
        background: "var(--surface-elevated)",
        flexShrink: 0,
        position: "relative",
      }}
    >
      {/* `/` command or `@` mention popover (above the input) */}
      {popoverOpen && trigger && (
        <div style={popoverStyle}>
          {trigger.kind === "command"
            ? trigger.items.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickCommand(c);
                  }}
                  onMouseEnter={() => setSel(i)}
                  style={popRowStyle(i === sel)}
                >
                  <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, fontWeight: 600, color: i === sel ? "var(--fg-inverse)" : "var(--fg-primary)" }}>
                    {commandDisplay(c)}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 11,
                      color: i === sel ? "rgba(10,10,10,0.8)" : "var(--fg-tertiary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {c.description}
                  </span>
                </button>
              ))
            : trigger.items.map((c, i) => {
                const Icon = MENTION_ICON[c.kind];
                return (
                  <button
                    key={c.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickMention(c);
                    }}
                    onMouseEnter={() => setSel(i)}
                    style={popRowStyle(i === sel)}
                  >
                    <Icon style={{ width: 12, height: 12, color: i === sel ? "var(--fg-inverse)" : "var(--fg-secondary)", flexShrink: 0 }} />
                    <span
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: 12,
                        fontWeight: 500,
                        color: i === sel ? "var(--fg-inverse)" : "var(--fg-primary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.name}
                    </span>
                    {c.namespace && (
                      <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: i === sel ? "rgba(10,10,10,0.7)" : "var(--fg-tertiary)", whiteSpace: "nowrap" }}>
                        {c.namespace}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono, monospace)", fontSize: 9, fontWeight: 600, letterSpacing: 0.5, color: i === sel ? "rgba(10,10,10,0.7)" : "var(--fg-tertiary)" }}>
                      {MENTION_KIND_LABEL[c.kind]}
                    </span>
                  </button>
                );
              })}
        </div>
      )}

      {/* Model picker menu — agent-aware. Rendered outside the rounded container
          so its upward-opening menu isn't clipped by the container's
          overflow:hidden. The model list + the effort section come from the
          ACTIVE agent's GET /api/agents/<id>/models response. */}
      {modelOpen && modelConfig && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 25 }} onClick={() => setModelOpen(false)} />
          <div style={modelMenuStyle} role="listbox" aria-label="Model">
            <div style={modelSectionLabel}>{modelHeaderLabel(agentId)}</div>

            {showModelSearch && (
              <div style={modelSearchStyle}>
                <Search size={13} style={{ color: "var(--fg-tertiary)", flexShrink: 0 }} />
                <input
                  type="text"
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                  placeholder="Search models…"
                  aria-label="Search models"
                  autoFocus
                  style={modelSearchInputStyle}
                />
              </div>
            )}

            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {filteredModels.length === 0 ? (
                <div style={{ ...modelSectionLabel, color: "var(--fg-tertiary)", fontWeight: 400 }}>
                  {models.length === 0 ? "No models available" : "No matches"}
                </div>
              ) : (
                filteredModels.map((m) => {
                  const active = modelConfig.model === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => onModelConfig({ ...modelConfig, model: m })}
                      style={modelRowStyle(active)}
                    >
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {modelName(agentId, m)}
                      </span>
                      {active && <Check style={checkStyle} />}
                    </button>
                  );
                })
              )}
            </div>

            {/* Reasoning effort — Claude only (efforts is empty otherwise). */}
            {efforts.length > 0 && (
              <>
                <div style={effortDividerStyle} />
                <div style={{ ...modelSectionLabel, marginTop: 2 }}>Reasoning effort</div>
                <div style={effortSegmentStyle}>
                  {efforts.map((ef) => {
                    const active = modelConfig.effort === ef;
                    return (
                      <button
                        key={ef}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onModelConfig({ ...modelConfig, effort: ef })}
                        style={effortPillStyle(active)}
                      >
                        {effortName(ef)}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* Rounded container */}
      <div style={{ background: "var(--surface-sunken)", borderRadius: 10, border: "1px solid #34353A", overflow: "hidden" }}>
        <textarea
          ref={textareaRef}
          value={value}
          rows={MIN_LINES}
          disabled={disabled}
          placeholder={notConfigured ? PLACEHOLDER_UNCONFIGURED : PLACEHOLDER}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
          }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onKeyDown={handleKeyDown}
          style={{
            ...textareaStyle,
            ...(disabled ? { opacity: 0.6, cursor: "not-allowed" } : null),
          }}
        />
        {/* Control row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px 8px", position: "relative" }}>
          {/* Model picker — the active agent's glyph + selected model + chevron. */}
          <button
            type="button"
            onClick={() => setModelOpen((o) => !o)}
            disabled={!modelConfig}
            title="Choose model"
            aria-label="Choose model"
            style={{ ...pillStyle, display: "flex", alignItems: "center", gap: 5, cursor: modelConfig ? "pointer" : "default" }}
          >
            {agentId && (
              <span style={{ display: "flex", color: "var(--accent-primary)", flexShrink: 0 }}>
                <AgentGlyph id={agentId} size={12} />
              </span>
            )}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
              {modelConfig ? modelLabel(agentId, modelConfig.model) : "Model"}
            </span>
            <ChevronDown size={11} style={{ color: "var(--fg-tertiary)", flexShrink: 0 }} />
          </button>

          {/* Commands pill — opens the / popover */}
          <button
            type="button"
            style={{ ...pillStyle, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}
            title="Browse chat commands"
            onClick={() => {
              if (!value.startsWith("/")) onChange("/" + value);
              setCaretAt(1);
            }}
          >
            <span style={{ fontFamily: "monospace", fontSize: 9 }}>&lt;/&gt;</span>
            <span>commands</span>
          </button>

          <div style={{ flex: 1 }} />

          {/* Send / Stop */}
          {isStreaming ? (
            <button onClick={onStop} aria-label="Stop" style={sendBtnStyle("#EF4444")}>
              <span style={{ display: "block", width: 10, height: 10, background: "var(--fg-primary)", borderRadius: 1 }} />
            </button>
          ) : (
            <button onClick={onSend} disabled={!canSend} aria-label="Send" style={sendBtnStyle(canSend ? "var(--accent-primary)" : "var(--border-strong)")}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ display: "block" }}>
                <path d="M6 10V2M6 2L2 6M6 2l4 4" stroke={canSend ? "#0A0A0A" : "#fff"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  background: "transparent",
  border: "none",
  outline: "none",
  resize: "none",
  color: "var(--fg-primary)",
  fontSize: 13,
  lineHeight: `${LINE_HEIGHT}px`,
  minHeight: LINE_HEIGHT * MIN_LINES,
  maxHeight: LINE_HEIGHT * MAX_LINES,
  padding: "10px 10px 0",
  fontFamily: "var(--font-geist, system-ui, sans-serif)",
};

const pillStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--fg-tertiary)",
  background: "var(--surface-elevated)",
  padding: "2px 7px",
  borderRadius: 100,
  border: "1px solid #34353A",
  whiteSpace: "nowrap",
  fontWeight: 500,
};

const popoverStyle: React.CSSProperties = {
  position: "absolute",
  left: 12,
  right: 12,
  bottom: "100%",
  marginBottom: 6,
  background: "var(--surface-elevated)",
  border: "1px solid #34353A",
  borderRadius: 8,
  boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
  overflow: "hidden",
  zIndex: 30,
  padding: 4,
  maxHeight: 280,
  overflowY: "auto",
};

function popRowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    textAlign: "left",
    padding: "6px 8px",
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    background: active ? "var(--accent-primary)" : "transparent",
  };
}

const modelMenuStyle: React.CSSProperties = {
  position: "absolute",
  left: 12,
  bottom: "100%",
  marginBottom: 6,
  zIndex: 30,
  background: "#18181B",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
  padding: 8,
  width: 280,
};

const modelSectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.3,
  color: "var(--fg-tertiary)",
  padding: "4px 8px 6px",
};

const modelSearchStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "var(--surface-sunken)",
  border: "1px solid #26272B",
  borderRadius: 8,
  padding: "7px 10px",
  margin: "0 2px 6px",
};

const modelSearchInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "none",
  outline: "none",
  color: "var(--fg-primary)",
  fontSize: 12,
  fontFamily: "var(--font-geist, system-ui, sans-serif)",
};

function modelRowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    textAlign: "left",
    padding: "8px 10px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    background: active ? "rgba(56,189,248,0.08)" : "transparent",
    color: active ? "var(--fg-primary)" : "#C9C9CF",
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: 12,
    fontWeight: 400,
  };
}

const checkStyle: React.CSSProperties = { width: 14, height: 14, color: "#38BDF8", flexShrink: 0 };

const effortDividerStyle: React.CSSProperties = {
  height: 1,
  background: "rgba(255,255,255,0.07)",
  margin: "6px 2px",
};

const effortSegmentStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "0 2px 2px",
  flexWrap: "wrap",
};

function effortPillStyle(active: boolean): React.CSSProperties {
  return {
    flex: "1 1 auto",
    textAlign: "center",
    padding: "5px 8px",
    borderRadius: 7,
    border: `1px solid ${active ? "rgba(56,189,248,0.5)" : "#34353A"}`,
    cursor: "pointer",
    background: active ? "rgba(56,189,248,0.12)" : "transparent",
    color: active ? "var(--fg-primary)" : "var(--fg-secondary)",
    fontSize: 11,
    fontWeight: 500,
    whiteSpace: "nowrap",
  };
}

/** "CLAUDE · MODEL" / "CODEX · MODEL" / "OPENCODE · PROVIDER / MODEL". */
function modelHeaderLabel(agentId: AgentId | undefined): string {
  if (agentId === "opencode") return "OPENCODE · PROVIDER / MODEL";
  return `${(agentId ?? "agent").toUpperCase()} · MODEL`;
}

function sendBtnStyle(bg: string): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: 7,
    background: bg,
    border: "none",
    cursor: "pointer",
    flexShrink: 0,
    transition: "background 120ms",
  };
}
