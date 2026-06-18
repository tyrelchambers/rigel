import { useState } from "react";
import { Copy, Check } from "lucide-react";

/**
 * DiffView — renders a unified git diff (the string from `git diff -- <file>`)
 * as a readable, GitHub-style unified diff: per-line old/new gutters, colored
 * add/remove rows, and hunk separators. The git preamble (`diff --git`, `index`,
 * `--- a/…`, `+++ b/…`) is stripped because the caller already shows the file
 * path. A copy button yields the original raw diff text.
 *
 * Reused by the proposeRepoFix confirm flow and anywhere a repo change is
 * previewed before opening a PR.
 */

type Kind = "context" | "add" | "del" | "hunk" | "meta";

interface Row {
  kind: Kind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

// Header lines git emits before the hunks. The caller shows the file path, so
// these are pure noise in the preview and are dropped.
const PREAMBLE =
  /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files)/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Per-kind visual treatment. Gutter colors are opaque (pre-blended over the
 *  sunken #08080A surface) so the sticky line-number column stays solid while
 *  the code scrolls horizontally beneath it. */
const STYLE: Record<Exclude<Kind, "hunk" | "meta">, { row: string; gutter: string; border: string; sign: string; char: string }> = {
  add: { row: "rgba(16,185,129,0.09)", gutter: "#091815", border: "#10B981", sign: "#34D399", char: "+" },
  del: { row: "rgba(239,68,68,0.09)", gutter: "#1D0D0F", border: "#EF4444", sign: "#F87171", char: "−" },
  context: { row: "transparent", gutter: "#08080A", border: "#16171A", sign: "transparent", char: " " },
};

export function parseDiff(diff: string): { rows: Row[]; adds: number; dels: number } {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  let adds = 0;
  let dels = 0;
  for (const line of diff.split("\n")) {
    if (line === "") continue; // trailing artifact of the final newline
    if (PREAMBLE.test(line)) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: "hunk", oldNo: null, newNo: null, text: hunk[3].trim() });
      continue;
    }
    const mark = line[0];
    if (mark === "+") {
      rows.push({ kind: "add", oldNo: null, newNo, text: line.slice(1) });
      newNo++;
      adds++;
    } else if (mark === "-") {
      rows.push({ kind: "del", oldNo, newNo: null, text: line.slice(1) });
      oldNo++;
      dels++;
    } else if (mark === "\\") {
      rows.push({ kind: "meta", oldNo: null, newNo: null, text: line.slice(2) }); // "\ No newline at end of file"
    } else {
      rows.push({ kind: "context", oldNo, newNo, text: line.startsWith(" ") ? line.slice(1) : line });
      oldNo++;
      newNo++;
    }
  }
  return { rows, adds, dels };
}

/** Fixed gutter width keeps hunk/meta rows aligned with code rows. */
const GUTTER = "w-9 shrink-0 px-1.5 text-right";

function DiffRow({ row }: { row: Row }) {
  if (row.kind === "hunk") {
    return (
      <div className="flex w-max min-w-full select-none" style={{ background: "#0E0F13", borderTop: "1px solid #1B1C1F", borderBottom: "1px solid #1B1C1F" }}>
        <span className="sticky left-0 w-[4.5rem] shrink-0" style={{ background: "#0E0F13" }} />
        <span className="px-2 py-0.5 text-[11px]" style={{ color: "var(--accent-soft)" }}>
          @@{row.text ? <span className="ml-2 text-[var(--fg-tertiary)]">{row.text}</span> : null}
        </span>
      </div>
    );
  }
  if (row.kind === "meta") {
    return (
      <div className="flex w-max min-w-full select-none">
        <span className="sticky left-0 w-[4.5rem] shrink-0" style={{ background: "#08080A" }} />
        <span className="px-2 py-0.5 text-[11px] italic text-[var(--fg-tertiary)]">{row.text}</span>
      </div>
    );
  }

  const s = STYLE[row.kind];
  return (
    <div className="flex w-max min-w-full" style={{ background: s.row }}>
      <span className="sticky left-0 flex shrink-0 select-none tabular-nums text-[var(--fg-tertiary)]" style={{ background: s.gutter }}>
        <span className={GUTTER}>{row.oldNo ?? ""}</span>
        <span className={GUTTER}>{row.newNo ?? ""}</span>
      </span>
      <span className="w-5 shrink-0 select-none border-l-2 text-center" style={{ borderColor: s.border, color: s.sign }}>
        {s.char}
      </span>
      <span className="whitespace-pre pr-4 text-[var(--fg-primary)]" style={{ opacity: row.kind === "context" ? 0.7 : 1 }}>
        {row.text}
      </span>
    </div>
  );
}

export function DiffView({ diff }: { diff: string }) {
  const { rows, adds, dels } = parseDiff(diff);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(diff).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="overflow-hidden rounded-lg" style={{ background: "#08080A", border: "1px solid #26272B" }}>
      {/* Summary bar: change magnitude + copy */}
      <div className="flex items-center gap-3 px-3 py-1.5" style={{ borderBottom: "1px solid #1B1C1F", background: "#0B0B0E" }}>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--fg-tertiary)]">Diff</span>
        <span className="ml-auto flex items-center gap-2.5 font-mono text-[11px] tabular-nums">
          <span style={{ color: "#34D399" }}>+{adds}</span>
          <span style={{ color: "#F87171" }}>−{dels}</span>
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy diff"}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
        >
          {copied ? <Check className="size-3" style={{ color: "#34D399" }} /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* Lines */}
      <div className="max-h-72 overflow-auto font-mono text-[12px] leading-[1.65]">
        {rows.map((r, i) => (
          <DiffRow key={i} row={r} />
        ))}
      </div>
    </div>
  );
}
