import { isValidElement, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/lib/useCopyToClipboard";
import { cn } from "@/lib/utils";

/** Recursively flatten a React node tree to its text content. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

/** Read the fenced language from the child `<code class="language-xxx">`. */
function codeLang(children: ReactNode): string {
  if (isValidElement(children)) {
    const className = (children.props as { className?: string }).className;
    const match = /language-([\w-]+)/.exec(className ?? "");
    if (match) return match[1];
  }
  return "text";
}

/** react-markdown `pre` override: a framed code block with a language header + Copy button. */
export function CodeBlock({ children }: { children?: ReactNode }) {
  const { copied, copy } = useCopyToClipboard();
  const text = nodeText(children).replace(/\n$/, "");
  const lang = codeLang(children);
  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-[var(--border-subtle)]">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3 py-1">
        <span className="font-mono text-3xs tracking-[1px] text-[var(--fg-tertiary)] uppercase">{lang}</span>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy code"}
          onClick={() => copy(text)}
          className={cn(
            "inline-flex cursor-pointer items-center gap-[5px] text-2xs leading-none",
            copied ? "text-[var(--status-running)]" : "text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]",
          )}
        >
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
