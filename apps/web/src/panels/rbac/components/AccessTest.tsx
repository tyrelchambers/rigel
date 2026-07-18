import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCheck,
  faXmark,
  faCircleQuestion,
  faShieldCheck,
  faSpinner,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import type { Subject } from "../types";
import type { CanICheck, CanIResult } from "../canI";
import { postCanICheck } from "@/lib/api";

interface Props {
  subject: Subject;
  checks: CanICheck[];
  /** Copy for a check the subject cannot currently perform. In the New binding
   *  dialog the binding doesn't exist yet, so "no" means the grant will add it. */
  deniedLabel?: string;
}

/** A per-subject "Test access" trigger that runs impersonated `can-i` against a
 *  set of checks and lists ✓ already-allowed / ✗ denied / ? unknown per check.
 *  Shared by the New binding dialog and Role detail view. */
export function AccessTest({ subject, checks, deniedLabel = "not currently allowed" }: Props) {
  const [results, setResults] = useState<CanIResult[] | null>(null);
  const [note, setNote] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the subject changes so a reused instance never shows another
  // subject's results (subject primitives only — `checks` is a fresh array each
  // parent render and must not retrigger this).
  useEffect(() => {
    setResults(null);
    setNote(undefined);
    setError(null);
  }, [subject.kind, subject.name, subject.namespace]);

  const disabled = loading || checks.length === 0 || !(subject.name ?? "").trim();

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const r = await postCanICheck([subject], checks);
      setResults(r.results[0]?.checks ?? []);
      setNote(r.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to test access");
    } finally {
      setLoading(false);
    }
  }

  const label = subject.kind === "ServiceAccount" && subject.namespace
    ? `${subject.namespace}:${subject.name}`
    : subject.name ?? "";

  return (
    <div className="flex flex-col gap-[7px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[12px] py-[10px]">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 break-all font-[var(--font-mono)] text-xs text-[var(--fg-secondary)]">
          {subject.kind ?? "ServiceAccount"} · {label || "—"}
        </span>
        <button
          type="button"
          onClick={run}
          disabled={disabled}
          className="flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-[10px] py-[5px] text-xs font-medium text-[var(--fg-primary)] transition-colors hover:bg-white/[0.06] disabled:opacity-40"
        >
          {loading ? <FontAwesomeIcon icon={faSpinner} className="size-[13px] animate-spin" /> : <FontAwesomeIcon icon={faShieldCheck} className="size-[13px]" />}
          Test access
        </button>
      </div>

      {error && <span className="text-2xs text-[var(--status-failed)]">{error}</span>}
      {note && <span className="text-2xs text-[var(--fg-tertiary)]">{note}</span>}

      {results && results.length > 0 && (
        <div className="flex flex-col gap-[3px]">
          {results.map((r, i) => (
            <div key={i} className="flex items-center gap-[8px] font-[var(--font-mono)] text-2xs">
              {r.allowed === true ? (
                <FontAwesomeIcon icon={faCheck} className="size-[13px] shrink-0 text-[var(--status-running)]" />
              ) : r.allowed === false ? (
                <FontAwesomeIcon icon={faXmark} className="size-[13px] shrink-0 text-[var(--fg-tertiary)]" />
              ) : (
                <FontAwesomeIcon icon={faCircleQuestion} className="size-[13px] shrink-0 text-[var(--fg-tertiary)]" />
              )}
              <span className="text-[var(--fg-secondary)]">
                {r.verb} {r.resource}
                {r.apiGroup && r.apiGroup !== "" ? `.${r.apiGroup}` : ""}
              </span>
              <span className="text-[var(--fg-tertiary)]">
                {r.allowed === true ? "already allowed" : r.allowed === false ? deniedLabel : "unknown"}
              </span>
            </div>
          ))}
        </div>
      )}
      {results && results.length === 0 && (
        <span className="text-2xs text-[var(--fg-tertiary)]">This role grants no testable rules.</span>
      )}
    </div>
  );
}
