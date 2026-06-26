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

/** react-markdown `pre` override: a fenced code block with a floating Copy button. */
export function CodeBlock({ children }: { children?: ReactNode }) {
  const { copied, copy } = useCopyToClipboard();
  const text = nodeText(children).replace(/\n$/, "");
  return (
    <div className="relative">
      <pre>{children}</pre>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy code"}
        onClick={() => copy(text)}
        className={cn(
          "absolute top-2 right-2 inline-flex items-center gap-[5px] px-2 py-1",
          "rounded-md text-[12px] leading-none cursor-pointer",
          "bg-[var(--surface-elevated)] border border-[var(--border-subtle)]",
          copied ? "text-[var(--status-running)]" : "text-[var(--fg-secondary)]",
        )}
      >
        {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
      </button>
    </div>
  );
}
