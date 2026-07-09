/**
 * remarkAlerts — tag GitHub-style `> [!TYPE]` blockquotes so the chat renderer
 * can draw them as typed callouts. Sets `data.hProperties.className` to
 * `markdown-alert markdown-alert-<type>` and strips the `[!TYPE]` marker from
 * the body. Plain blockquotes (no marker) are left as-is → gray quote callout.
 */
const ALERT = /^\s*\[!(note|tip|important|warning|caution)\]\s*(?:\n|$)/i;

export function remarkAlerts() {
  return (tree: unknown) => {
    walk(tree as Node);
  };
}

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hProperties?: Record<string, unknown> };
}

function walk(node: Node): void {
  if (!node || !Array.isArray(node.children)) return;
  for (const child of node.children) {
    if (child.type === "blockquote") tagAlert(child);
    walk(child);
  }
}

function tagAlert(blockquote: Node): void {
  const paragraph = blockquote.children?.[0];
  if (!paragraph || paragraph.type !== "paragraph") return;
  const text = paragraph.children?.[0];
  if (!text || text.type !== "text" || typeof text.value !== "string") return;
  const match = ALERT.exec(text.value);
  if (!match) return;
  const type = match[1].toLowerCase();
  text.value = text.value.slice(match[0].length);
  if (text.value === "") paragraph.children!.shift();
  blockquote.data = blockquote.data ?? {};
  blockquote.data.hProperties = {
    ...(blockquote.data.hProperties ?? {}),
    className: `markdown-alert markdown-alert-${type}`,
  };
}
