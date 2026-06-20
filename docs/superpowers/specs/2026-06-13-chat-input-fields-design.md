# Chat input fields — design

**Date:** 2026-06-13
**Status:** Approved (pending written-spec review)
**Scope:** Both apps (web + Swift) in one pass, via the parity-feature (mode=feature) flow.

## Problem

The Rigel AI can already ask the user to **choose** between options: it emits a
fenced ` ```question ` block (`{ question, options: [{ label, value? }] }`) which both
apps render as instant-send purple option rows. But when the AI needs **free-text**
from the user (e.g. "send me the real hostname"), it has no structured way to collect
it — the user has to type into the main composer, disconnected from the question, and
the AI gets an unlabeled blob it must guess the meaning of.

The user wants:

1. An option that is itself a **text input** (looks like an option row, but you type
   into it) with context — the standalone "just give me the hostname" case.
2. The ability to **choose an action AND include input** when the AI wants it
   ("choose an action and include input if the ai wants it").

The AI should declare the **named parameters** it needs; the user's typed text maps
to the right variable so the AI knows exactly which slot was filled.

## Approach

Extend the **existing ` ```question ` channel** — do not add a new block kind. This
keeps the parser, `stripActionBlocks`, and Swift/web parity simple, and reuses the
already-built rendering + answer-routing plumbing.

Each option gains an optional `fields` array. Field count per option: **multiple
named fields (mini-form)** — an option can collect several params at once.

### Schema

```json
{
  "question": "There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?",
  "options": [
    {
      "label": "Deploy AFFiNE too",
      "value": "Deploy AFFiNE and expose it",
      "fields": [
        { "name": "hostname", "label": "Public hostname", "placeholder": "affine.example.com", "required": true },
        { "name": "port", "label": "Service port", "placeholder": "3010", "required": false }
      ]
    },
    { "label": "Just give me the Ingress YAML" }
  ]
}
```

**Option semantics**

- Option with **no `fields`** → today's instant-send button (unchanged behavior).
- Option with `fields` → expands into an inline mini-form when picked; submit sends
  the choice + named params.
- **Standalone input row** ("just type a hostname") → the AI emits a single
  input-bearing option (one or more fields). Because it is the only option, it
  renders **always-open** with a pencil glyph instead of a radio.

**Field shape**

| key | type | meaning |
|-----|------|---------|
| `name` | string (required) | The variable the AI is asking for; the user's text maps to it. |
| `label` | string (optional) | Human label shown next to the field. Defaults to `name`. |
| `placeholder` | string (optional) | Example/hint text inside the field. |
| `required` | bool (optional, default `true`) | Submit is gated until all required fields are non-empty. |

Malformed fields (missing `name`, not an object) are dropped; an option whose every
field is dropped degrades to a plain instant-send button. Malformed/empty `question`
blocks remain silently skipped, as today.

### Rendering

- Same purple row styling as the existing option rows (`QuestionOptionRow` parity:
  10h/7v padding, 4px radius, 12px semibold accent text, `primaryDim` bg, 0.4 border).
- Picking an input-bearing option **expands** its fields inline, indented under the
  row; selecting another option collapses it (single-select, radio semantics). This
  is the rule **whenever there are 2+ options**, including a "standalone-style" input
  option shown alongside choices — it is a row you tap to open, not always-open.
- The **only** always-open case: when the block has **exactly one option** and it is
  input-bearing (the pure "just type the value" prompt). It renders open with a pencil
  glyph in place of the radio circle, no tap required.
- Each field: small label + a text input matching the row's accent treatment.
- **Submit affordance:** pressing Enter in the last field submits; a small `↵` submit
  button is also shown. Submit is **disabled until every `required` field is
  non-empty**; optional fields may be blank.

### Submit / message format

Reuse the existing blockquote answer pattern (`ClarifyingQuestion.combinedAnswer`)
so the AI re-anchors on the question it asked, then receives the chosen path and the
named params, one per line. Blank optional params are omitted.

```
> There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?
Deploy AFFiNE and expose it
hostname: affine.example.com
port: 3010
```

For a plain (fieldless) option, the message is unchanged from today
(`> question` + `value ?? label`).

## Components & files

**Shared / web**

- `packages/k8s/src/actionBlocks.ts` — extend `SuggestedQuestion` option type with
  `fields?: QuestionField[]`; parse + validate fields in `extractQuestionBlocks`; add
  a `buildQuestionAnswer(question, option, values)` helper that produces the
  blockquote message (single source of truth, shared shape with Swift).
- `packages/k8s/src/actionBlocks.test.ts` — coverage: fields parsed, malformed fields
  dropped, all-dropped option degrades to plain, required-gating in the answer
  builder, blank optional omitted.
- `apps/web/src/panels/chat/SuggestedQuestionList.tsx` — expand-on-pick mini-form;
  always-open lone input; required-gated submit; Enter-to-submit.
- `apps/server/src/systemPrompt.ts` — teach the AI the `fields` schema and when to use
  it (need a value from the user → attach `fields` instead of asking them to type in
  prose).

**Swift parity**

- `Sources/Rigel/Chat/ClarifyingQuestion.swift` — add `fields` to `Option`; decode;
  port the `buildQuestionAnswer` logic (or extend `combinedAnswer`).
- `Sources/Rigel/Chat/MessageViews.swift` — `QuestionOptionRow` expand-to-form;
  always-open lone input; submit gating.
- `Sources/Rigel/Chat/ClaudeSession.swift` (systemPrompt) — mirror the web prompt
  guidance so both apps emit the same blocks.

## Edge cases

- No options at all → component renders nothing (today's behavior).
- Option with `fields` but all malformed → plain instant-send button.
- Required field left blank → submit disabled (web) / disabled (Swift), no send.
- Multiple input-bearing options → each expands on pick, only one open at a time;
  picking a fieldless option still instant-sends.
- Mid-stream/unterminated `question` fence → dropped from display until closed
  (unchanged).
- Batch (multi-question) mode: web does not yet have batch; this design targets the
  single-question instant/expand flow. Swift batch view (`ClarifyingQuestionBatchView`)
  keeps working for fieldless options; attaching fields inside batch is **out of scope**
  for this pass (YAGNI — call it out, don't build).

## Testing

- `packages/k8s` vitest: parser + answer-builder cases above.
- `apps/web` vitest: `SuggestedQuestionList` renders fields, gates submit on required,
  emits the correct blockquote message on submit.
- Swift `swift test`: `ClarifyingQuestion` decode + answer-builder.
- Manual: rebuild the Docker container, drive a real AI turn that asks for a hostname,
  confirm the inline form + correct message back.

## Non-goals

- Field validation beyond required/non-empty (no regex, no type coercion) — YAGNI.
- Fields inside the Swift batch (multi-question) view.
- A new fenced block kind.
