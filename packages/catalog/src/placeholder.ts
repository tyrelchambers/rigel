// Placeholder scanning, substitution, and manifest-shape validation — port of
// Sources/Rigel/Catalog/{PlaceholderScanner,ManifestShape}.swift.

export const MARKER = "<FILL_ME_IN>";

/** One value the generated install manifest needs the operator to supply. */
export interface ManifestPlaceholder {
  key: string;
}

interface PlaceholderLine {
  index: number;
  key: string;
  isMarker: boolean;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

function keyOf(trimmed: string): string | null {
  const colon = trimmed.indexOf(":");
  if (colon === -1) return null;
  const key = trimmed.slice(0, colon).trim();
  return key.length === 0 ? null : key;
}

function keyValue(trimmed: string): [string, string] | null {
  const colon = trimmed.indexOf(":");
  if (colon === -1) return null;
  const key = trimmed.slice(0, colon).trim();
  const value = trimmed.slice(colon + 1).trim();
  return key.length === 0 ? null : [key, value];
}

function dequote(s: string): string {
  let v = s;
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

/**
 * Walk the manifest once, yielding the lines that need a value. Tracks whether
 * we're inside a `Secret`'s `data`/`stringData` block (by indent) so empty
 * values are only treated as placeholders there. Mirrors Swift
 * `PlaceholderScanner.placeholderLines`.
 */
function placeholderLines(lines: string[]): PlaceholderLine[] {
  const out: PlaceholderLine[] = [];
  let inSecret = false;
  let dataIndent: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = leadingSpaces(line);
    const trimmed = line.trim();

    if (trimmed === "---") {
      inSecret = false;
      dataIndent = null;
    } else if (trimmed.startsWith("kind:")) {
      inSecret = trimmed.slice("kind:".length).trim() === "Secret";
      dataIndent = null;
    }

    if (line.includes(MARKER)) {
      const key = keyOf(trimmed);
      if (key !== null) out.push({ index: i, key, isMarker: true });
      continue;
    }

    if (inSecret && (trimmed === "data:" || trimmed === "stringData:")) {
      dataIndent = indent;
      continue;
    }

    if (inSecret && dataIndent !== null) {
      if (indent > dataIndent) {
        const kv = keyValue(trimmed);
        if (kv && dequote(kv[1]).length === 0) {
          out.push({ index: i, key: kv[0], isMarker: false });
        }
      } else if (trimmed.length !== 0) {
        dataIndent = null; // dedented out of the data block
      }
    }
  }
  return out;
}

/**
 * Find all `<FILL_ME_IN>` markers and empty Secret data values, deduplicated by
 * key. Mirrors Swift `PlaceholderScanner.scan`.
 */
export function scanPlaceholders(yaml: string): ManifestPlaceholder[] {
  const seen = new Set<string>();
  const out: ManifestPlaceholder[] = [];
  for (const p of placeholderLines(yaml.split("\n"))) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    out.push({ key: p.key });
  }
  return out;
}

/**
 * Replace markers in place (preserving surrounding quotes/URL structure) and
 * fill empty Secret values. Keys with no/empty supplied value are left alone so
 * `hasUnfilledMarkers` can still catch them. Mirrors Swift
 * `PlaceholderScanner.substitute`.
 */
export function substitutePlaceholders(
  yaml: string,
  values: Record<string, string>,
): string {
  const lines = yaml.split("\n");
  for (const p of placeholderLines(lines)) {
    const v = values[p.key];
    if (v === undefined || v.length === 0) continue;
    if (p.isMarker) {
      lines[p.index] = lines[p.index].split(MARKER).join(v);
    } else {
      const indent = " ".repeat(leadingSpaces(lines[p.index]));
      const escaped = v.split("'").join("''");
      lines[p.index] = `${indent}${p.key}: '${escaped}'`;
    }
  }
  return lines.join("\n");
}

/** True if a `<FILL_ME_IN>` marker remains anywhere. Mirrors Swift `hasUnfilledMarkers`. */
export function hasUnfilledMarkers(yaml: string): boolean {
  return yaml.includes(MARKER);
}

// --- Manifest shape validation (ManifestShape.swift) -----------------------

/** Split on document separators — a line that is exactly `---` (whitespace ok). */
function splitDocuments(yaml: string): string[] {
  const docs: string[] = [];
  let current: string[] = [];
  for (const line of yaml.split("\n")) {
    if (line.trim() === "---") {
      docs.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  docs.push(current.join("\n"));
  return docs;
}

/** True if `line` is a top-level (column-0) mapping key named `key`. */
function isTopLevelKey(line: string, key: string): boolean {
  // Top-level => no leading whitespace.
  if (line.length === 0 || /\s/.test(line[0])) return false;
  const prefix = `${key}:`;
  return line === key || line.startsWith(prefix);
}

/**
 * nil if every non-empty, non-comment YAML document declares a top-level
 * `apiVersion:` AND a top-level `kind:`; otherwise a human-readable reason
 * naming the offending document. Mirrors Swift `ManifestShape.validationError`.
 */
export function validateManifestShape(yaml: string): string | null {
  const documents = splitDocuments(yaml);
  for (let index = 0; index < documents.length; index++) {
    const lines = documents[index].split("\n");
    const meaningful = lines.filter((line) => {
      const t = line.trim();
      return t.length !== 0 && !t.startsWith("#");
    });
    if (meaningful.length === 0) continue;

    const hasAPIVersion = meaningful.some((l) => isTopLevelKey(l, "apiVersion"));
    const hasKind = meaningful.some((l) => isTopLevelKey(l, "kind"));
    if (!hasAPIVersion || !hasKind) {
      const missing: string[] = [];
      if (!hasAPIVersion) missing.push("apiVersion");
      if (!hasKind) missing.push("kind");
      const snippet = (meaningful[0] ?? "").trim();
      const position = documents.length > 1 ? `document ${index + 1}` : "the manifest";
      return `${position} is missing top-level ${missing.join(" and ")} (near "${snippet.slice(0, 60)}")`;
    }
  }
  return null;
}
