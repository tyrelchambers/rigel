import { Button } from "@/components/ui/button";
import type { SuggestedQuestion } from "@/lib/actionBlocks";

interface Props {
  questions: SuggestedQuestion[];
  /** Send the picked option's value (or label) back as the user's next message. */
  onAnswer: (value: string) => void;
}

/**
 * SuggestedQuestionList — renders ```question blocks as a prompt + one button
 * per option (mirrors the Swift clarifying-question UI). Tapping an option sends
 * its `value` (or `label`) as the next message so Claude continues.
 */
export function SuggestedQuestionList({ questions, onAnswer }: Props) {
  if (questions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1.5">
          <div className="text-[13px] font-medium text-foreground">{q.question}</div>
          <div className="flex flex-wrap gap-2">
            {q.options.map((opt, oi) => (
              <Button
                key={oi}
                size="sm"
                variant="outline"
                onClick={() => onAnswer(opt.value ?? opt.label)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
