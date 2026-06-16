import { useState } from "react";
import { Circle, CornerDownLeft, Pencil } from "lucide-react";
import { buildQuestionAnswer, type SuggestedQuestion } from "@/lib/actionBlocks";

type Option = SuggestedQuestion["options"][number];

interface Props {
  questions: SuggestedQuestion[];
  /** Send the picked option's answer (built by buildQuestionAnswer) as the user's next message. */
  onAnswer: (value: string) => void;
}

const COLOR = "#38BDF8";
const BG = "var(--accent-dim)";
const BG_HOVER = "rgba(56, 189, 248,0.22)";
const BORDER = "rgba(56, 189, 248,0.4)";

const rowStyle: React.CSSProperties = {
  color: COLOR,
  background: BG,
  border: `1px solid ${BORDER}`,
  borderRadius: "4px",
  padding: "7px 10px",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
  width: "100%",
  textAlign: "left",
  display: "flex",
  alignItems: "center",
  gap: "6px",
  outline: "none",
  transition: "background 0.15s",
};

function hoverHandlers(disabled = false) {
  if (disabled) return {};
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      (e.currentTarget as HTMLElement).style.background = BG_HOVER;
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      (e.currentTarget as HTMLElement).style.background = BG;
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      (e.currentTarget as HTMLElement).style.boxShadow = `0 0 0 2px ${BORDER}`;
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      (e.currentTarget as HTMLElement).style.boxShadow = "none";
    },
  };
}

/** An expandable mini-form: fields + a required-gated ↵ submit. Shared by the
 * pick-to-expand row (behavior b) and the always-open lone input (behavior c). */
function QuestionForm({
  question,
  option,
  onSubmit,
  locked,
}: {
  question: string;
  option: Option;
  onSubmit: (value: string) => void;
  locked: boolean;
}) {
  const fields = option.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});

  const canSubmit =
    !locked &&
    fields.every((f) => f.required === false || (values[f.name]?.trim() ?? "") !== "");

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(buildQuestionAnswer(question, option, values));
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        marginLeft: "16px",
        marginTop: "2px",
      }}
    >
      {fields.map((field) => (
        <label key={field.name} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <span style={{ fontSize: "11px", fontWeight: 600, color: COLOR }}>
            {field.label ?? field.name}
            {field.required === false ? null : <span style={{ opacity: 0.6 }}> *</span>}
          </span>
          <input
            type="text"
            disabled={locked}
            placeholder={field.placeholder}
            value={values[field.name] ?? ""}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            style={{
              fontSize: "12px",
              padding: "5px 8px",
              borderRadius: "4px",
              color: "inherit",
              background: BG,
              border: `1px solid ${BORDER}`,
              outline: "none",
            }}
            onFocus={(e) => {
              e.currentTarget.style.boxShadow = `0 0 0 2px ${BORDER}`;
            }}
            onBlur={(e) => {
              e.currentTarget.style.boxShadow = "none";
            }}
          />
        </label>
      ))}
      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        aria-label="Submit"
        style={{
          alignSelf: "flex-start",
          color: COLOR,
          background: BG,
          border: `1px solid ${BORDER}`,
          borderRadius: "4px",
          padding: "4px 8px",
          fontSize: "12px",
          fontWeight: 600,
          cursor: canSubmit ? "pointer" : "not-allowed",
          opacity: canSubmit ? 1 : 0.4,
          display: "flex",
          alignItems: "center",
          gap: "4px",
          outline: "none",
        }}
        {...hoverHandlers(!canSubmit)}
      >
        <CornerDownLeft size={11} strokeWidth={2.5} />
      </button>
    </div>
  );
}

/**
 * SuggestedQuestionList — renders ```question blocks (mirrors Swift's
 * single-question ClarifyingQuestionView). Three behaviors from one schema:
 *   (a) fieldless option        → instant-send button (today's behavior),
 *   (b) option with fields (2+) → pick-to-expand inline mini-form, single-open,
 *   (c) lone input-bearing opt  → always-open form with a pencil glyph.
 * The sent message is built by the shared buildQuestionAnswer. The block locks
 * after a successful send to prevent a double-send.
 *
 * Pixel-for-pixel parity with Swift's QuestionOptionRow (MessageViews.swift):
 *   padding 10h/7v · Radius.sm (4) · radio circle 10 semibold · label 12 semibold ·
 *   accent purple (#38BDF8) on primaryDim (rgba 56, 189, 248,0.15) with a 0.4 accent
 *   border; hover 0.22; 2px focus ring.
 */
export function SuggestedQuestionList({ questions, onAnswer }: Props) {
  const [lockedBlocks, setLockedBlocks] = useState<Record<number, boolean>>({});
  const [openOption, setOpenOption] = useState<Record<number, number>>({});

  if (questions.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col gap-3">
      {questions.map((q, qi) => {
        const locked = lockedBlocks[qi] === true;
        const inputBearing = q.options.filter((o) => (o.fields?.length ?? 0) > 0);
        const loneInput = q.options.length === 1 && inputBearing.length === 1;

        const send = (value: string) => {
          if (locked) return;
          setLockedBlocks((prev) => ({ ...prev, [qi]: true }));
          onAnswer(value);
        };

        return (
          <div key={qi} className="flex flex-col gap-1.5">
            <div className="text-[12px] font-medium text-foreground">{q.question}</div>
            {q.options.map((opt, oi) => {
              const hasFields = (opt.fields?.length ?? 0) > 0;

              // (c) Lone input-bearing option — always-open, pencil glyph, no tap.
              if (loneInput && hasFields) {
                return (
                  <div key={oi} className="flex flex-col gap-1.5">
                    <div style={{ ...rowStyle, cursor: "default" }}>
                      <Pencil size={10} strokeWidth={2.5} style={{ flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{opt.label}</span>
                    </div>
                    <QuestionForm
                      question={q.question}
                      option={opt}
                      onSubmit={send}
                      locked={locked}
                    />
                  </div>
                );
              }

              const isOpen = openOption[qi] === oi;

              // (b) Option with fields in a 2+ option block — pick to expand.
              if (hasFields) {
                return (
                  <div key={oi} className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => setOpenOption((prev) => ({ ...prev, [qi]: oi }))}
                      style={rowStyle}
                      {...hoverHandlers(locked)}
                    >
                      <Circle
                        size={10}
                        strokeWidth={2.5}
                        fill={isOpen ? COLOR : "none"}
                        style={{ flexShrink: 0 }}
                      />
                      <span style={{ flex: 1 }}>{opt.label}</span>
                    </button>
                    {isOpen && (
                      <QuestionForm
                        question={q.question}
                        option={opt}
                        onSubmit={send}
                        locked={locked}
                      />
                    )}
                  </div>
                );
              }

              // (a) Fieldless option — instant-send (unchanged).
              return (
                <button
                  key={oi}
                  type="button"
                  disabled={locked}
                  onClick={() => send(buildQuestionAnswer(q.question, opt, {}))}
                  style={rowStyle}
                  {...hoverHandlers(locked)}
                >
                  <Circle size={10} strokeWidth={2.5} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{opt.label}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
