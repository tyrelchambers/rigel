import Foundation

/// One value the generated install manifest needs the operator to supply: either
/// a `<FILL_ME_IN>` marker, or an empty value inside a Secret's data block.
struct ManifestPlaceholder: Identifiable, Equatable {
    let key: String
    var id: String { key }
}

/// Finds and fills the values a generated install manifest leaves for the user.
///
/// The catalog templates emit a single multi-document manifest with a
/// `<FILL_ME_IN>` placeholder Secret. Rather than depend on the model emitting a
/// separate schema, the wizard scans the manifest directly: any `<FILL_ME_IN>`
/// marker, plus any empty value inside a `Secret`'s `data`/`stringData` block
/// (which is what a half-followed "don't inline secrets" instruction produces).
/// The wizard collects values for these, then substitutes them back before apply
/// — and refuses to apply while any marker remains.
enum PlaceholderScanner {
    static let marker = "<FILL_ME_IN>"

    static func scan(_ yaml: String) -> [ManifestPlaceholder] {
        var seen = Set<String>()
        var out: [ManifestPlaceholder] = []
        for p in placeholderLines(yaml.components(separatedBy: "\n")) where !seen.contains(p.key) {
            seen.insert(p.key)
            out.append(ManifestPlaceholder(key: p.key))
        }
        return out
    }

    /// Replace markers in place (preserving surrounding quotes/URL structure) and
    /// fill empty Secret values. Keys with no/empty supplied value are left alone
    /// so `hasUnfilledMarkers` can still catch them.
    static func substitute(_ yaml: String, values: [String: String]) -> String {
        var lines = yaml.components(separatedBy: "\n")
        for p in placeholderLines(lines) {
            guard let v = values[p.key], !v.isEmpty else { continue }
            if p.isMarker {
                lines[p.index] = lines[p.index].replacingOccurrences(of: marker, with: v)
            } else {
                let indent = String(lines[p.index].prefix(while: { $0 == " " }))
                lines[p.index] = "\(indent)\(p.key): '\(v.replacingOccurrences(of: "'", with: "''"))'"
            }
        }
        return lines.joined(separator: "\n")
    }

    static func hasUnfilledMarkers(_ yaml: String) -> Bool {
        yaml.contains(marker)
    }

    // MARK: - Shared line walker

    private struct PlaceholderLine { let index: Int; let key: String; let isMarker: Bool }

    /// Walk the manifest once, yielding the lines that need a value. Tracks
    /// whether we're inside a `Secret`'s `data`/`stringData` block (by indent) so
    /// empty values are only treated as placeholders there.
    private static func placeholderLines(_ lines: [String]) -> [PlaceholderLine] {
        var out: [PlaceholderLine] = []
        var inSecret = false
        var dataIndent: Int? = nil

        for (i, line) in lines.enumerated() {
            let indent = line.prefix(while: { $0 == " " }).count
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed == "---" { inSecret = false; dataIndent = nil }
            else if trimmed.hasPrefix("kind:") {
                inSecret = trimmed.dropFirst("kind:".count).trimmingCharacters(in: .whitespaces) == "Secret"
                dataIndent = nil
            }

            if line.contains(marker) {
                if let key = keyOf(trimmed) { out.append(PlaceholderLine(index: i, key: key, isMarker: true)) }
                continue
            }

            if inSecret, trimmed == "data:" || trimmed == "stringData:" {
                dataIndent = indent
                continue
            }

            if inSecret, let di = dataIndent {
                if indent > di {
                    if let (key, value) = keyValue(trimmed), dequote(value).isEmpty {
                        out.append(PlaceholderLine(index: i, key: key, isMarker: false))
                    }
                } else if !trimmed.isEmpty {
                    dataIndent = nil   // dedented out of the data block
                }
            }
        }
        return out
    }

    private static func keyOf(_ trimmed: String) -> String? {
        guard let colon = trimmed.firstIndex(of: ":") else { return nil }
        let key = String(trimmed[..<colon]).trimmingCharacters(in: .whitespaces)
        return key.isEmpty ? nil : key
    }

    private static func keyValue(_ trimmed: String) -> (String, String)? {
        guard let colon = trimmed.firstIndex(of: ":") else { return nil }
        let key = String(trimmed[..<colon]).trimmingCharacters(in: .whitespaces)
        let value = String(trimmed[trimmed.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        return key.isEmpty ? nil : (key, value)
    }

    private static func dequote(_ s: String) -> String {
        var v = s
        if (v.hasPrefix("\"") && v.hasSuffix("\"")) || (v.hasPrefix("'") && v.hasSuffix("'")), v.count >= 2 {
            v = String(v.dropFirst().dropLast())
        }
        return v.trimmingCharacters(in: .whitespaces)
    }
}
