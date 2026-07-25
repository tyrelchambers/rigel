import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowLeft } from "@awesome.me/kit-6050953220/icons/classic/solid";

/** The head a sub-flow shows in place of the step's own, so the wizard always
 *  describes the screen the user is actually on. */
export function SubflowHead({
  title,
  description,
  onBack,
}: {
  title: string;
  description: string;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-2 self-start text-xs font-semibold text-[var(--accent-primary)]"
      >
        <FontAwesomeIcon icon={faArrowLeft} className="size-3" />
        All connection options
      </button>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-bold text-[var(--fg-primary)]">{title}</h2>
        <p className="text-sm leading-relaxed text-[var(--fg-secondary)]">{description}</p>
      </div>
    </div>
  );
}
