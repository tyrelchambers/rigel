/**
 * Trigger a browser download of `text` as a file named `filename`. Creates a
 * temporary object URL from a Blob, clicks a synthetic anchor, then revokes the
 * URL. Used for "Download YAML" and similar client-side exports.
 */
export function downloadText(filename: string, text: string, mime = "text/yaml"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
