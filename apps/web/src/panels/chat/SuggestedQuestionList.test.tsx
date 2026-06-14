// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SuggestedQuestionList } from "./SuggestedQuestionList";
import type { SuggestedQuestion } from "@/lib/actionBlocks";

afterEach(cleanup);

const QUESTION = "There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?";

function input(name: string) {
  return screen.getByText(name).parentElement!.querySelector("input") as HTMLInputElement;
}

test("lone input-bearing option renders always-open with a pencil glyph (no tap)", () => {
  const q: SuggestedQuestion[] = [
    {
      question: QUESTION,
      options: [
        {
          label: "Type the hostname",
          value: "Use this hostname",
          fields: [{ name: "hostname", label: "Public hostname", required: true }],
        },
      ],
    },
  ];
  const { container } = render(<SuggestedQuestionList questions={q} onAnswer={vi.fn()} />);
  // field input is present without any click
  expect(input("Public hostname")).toBeTruthy();
  // pencil glyph, not a radio circle (lucide sets a class on the svg)
  expect(container.querySelector("svg.lucide-pencil")).toBeTruthy();
  expect(container.querySelector("svg.lucide-circle")).toBeNull();
});

test("multi-option: field option is collapsed; picking expands; picking another collapses", () => {
  const q: SuggestedQuestion[] = [
    {
      question: QUESTION,
      options: [
        { label: "Deploy AFFiNE too", value: "Deploy it", fields: [{ name: "hostname", required: true }] },
        { label: "Just give me the YAML" },
      ],
    },
  ];
  render(<SuggestedQuestionList questions={q} onAnswer={vi.fn()} />);
  // collapsed: no input yet
  expect(screen.queryByText("hostname")).toBeNull();
  fireEvent.click(screen.getByText("Deploy AFFiNE too"));
  expect(screen.getByText("hostname")).toBeTruthy();
});

test("submit disabled until required fields filled; enabling once filled", () => {
  const q: SuggestedQuestion[] = [
    {
      question: QUESTION,
      options: [{ label: "Set host", fields: [{ name: "hostname", required: true }] }],
    },
  ];
  const { container } = render(<SuggestedQuestionList questions={q} onAnswer={vi.fn()} />);
  const submit = screen.getByLabelText("Submit") as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(input("hostname"), { target: { value: "affine.example.com" } });
  expect(submit.disabled).toBe(false);
  expect(container).toBeTruthy();
});

test("Enter submits when enabled, emits the shared blockquote message", () => {
  const onAnswer = vi.fn();
  const q: SuggestedQuestion[] = [
    {
      question: QUESTION,
      options: [
        {
          label: "Deploy",
          value: "Deploy AFFiNE and expose it",
          fields: [
            { name: "hostname", required: true },
            { name: "port", required: false },
          ],
        },
      ],
    },
  ];
  render(<SuggestedQuestionList questions={q} onAnswer={onAnswer} />);
  fireEvent.change(input("hostname"), { target: { value: "affine.example.com" } });
  // optional port left blank → omitted
  fireEvent.keyDown(input("hostname"), { key: "Enter" });
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(onAnswer).toHaveBeenCalledWith(
    [`> ${QUESTION}`, "Deploy AFFiNE and expose it", "hostname: affine.example.com"].join("\n"),
  );
});

test("Enter does nothing while submit is disabled", () => {
  const onAnswer = vi.fn();
  const q: SuggestedQuestion[] = [
    { question: QUESTION, options: [{ label: "Set host", fields: [{ name: "hostname", required: true }] }] },
  ];
  render(<SuggestedQuestionList questions={q} onAnswer={onAnswer} />);
  fireEvent.keyDown(input("hostname"), { key: "Enter" });
  expect(onAnswer).not.toHaveBeenCalled();
});

test("fieldless option in a mixed block still instant-sends on click", () => {
  const onAnswer = vi.fn();
  const q: SuggestedQuestion[] = [
    {
      question: QUESTION,
      options: [
        { label: "Deploy", fields: [{ name: "hostname", required: true }] },
        { label: "Just give me the YAML", value: "Give me the Ingress YAML" },
      ],
    },
  ];
  render(<SuggestedQuestionList questions={q} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByText("Just give me the YAML"));
  expect(onAnswer).toHaveBeenCalledWith(`> ${QUESTION}\nGive me the Ingress YAML`);
});

test("block locks after a successful send (no double-send)", () => {
  const onAnswer = vi.fn();
  const q: SuggestedQuestion[] = [
    {
      question: QUESTION,
      options: [
        { label: "A", value: "Answer A" },
        { label: "B", value: "Answer B" },
      ],
    },
  ];
  render(<SuggestedQuestionList questions={q} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByText("A"));
  fireEvent.click(screen.getByText("B"));
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(onAnswer).toHaveBeenCalledWith(`> ${QUESTION}\nAnswer A`);
});

test("renders nothing for zero questions", () => {
  const { container } = render(<SuggestedQuestionList questions={[]} onAnswer={vi.fn()} />);
  expect(container.firstChild).toBeNull();
});
