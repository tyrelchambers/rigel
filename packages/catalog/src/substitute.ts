// Template-variable substitution — port of Swift `CatalogApp.substitute`.

/**
 * Replace every `{{key}}` token with its value; unknown tokens are left as the
 * literal placeholder so gaps surface in the rendered manifest/prompt rather
 * than silently disappearing.
 *
 * Mirrors Swift `CatalogApp.substitute(_:vars:)` exactly:
 *   for (key, value) in vars { out = out.replacingOccurrences(of: "{{key}}", with: value) }
 */
export function substitute(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    // Escape regex-special chars in the key, then global-replace the {{key}} token.
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\{\\{${escaped}\\}\\}`, "g"), value);
  }
  return result;
}
