import Foundation

/// Pre-apply lint for the catalog wizard's MANIFEST branch: confirm the filled
/// YAML actually looks like Kubernetes resources before handing it to
/// `kubectl apply -f -`. Distinct purpose from secret/placeholder handling —
/// this only judges manifest *shape* (top-level apiVersion + kind per document).
enum ManifestShape {
    /// nil if every non-empty, non-comment YAML document declares a top-level
    /// (column-0) `apiVersion:` AND a top-level `kind:`; otherwise a
    /// human-readable reason naming the offending document.
    static func validationError(_ yaml: String) -> String? {
        let documents = splitDocuments(yaml)
        for (index, doc) in documents.enumerated() {
            let lines = doc.components(separatedBy: "\n")
            // Strip comment-only and blank lines to decide if the doc is empty.
            let meaningful = lines.filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                return !trimmed.isEmpty && !trimmed.hasPrefix("#")
            }
            if meaningful.isEmpty { continue }

            let hasAPIVersion = meaningful.contains { isTopLevelKey($0, "apiVersion") }
            let hasKind = meaningful.contains { isTopLevelKey($0, "kind") }
            if !hasAPIVersion || !hasKind {
                var missing: [String] = []
                if !hasAPIVersion { missing.append("apiVersion") }
                if !hasKind { missing.append("kind") }
                let snippet = meaningful.first?.trimmingCharacters(in: .whitespaces) ?? ""
                let position = documents.count > 1 ? "document \(index + 1)" : "the manifest"
                return "\(position) is missing top-level \(missing.joined(separator: " and ")) (near \"\(snippet.prefix(60))\")"
            }
        }
        return nil
    }

    /// Split on document separators — a line that is exactly `---`, allowing
    /// leading/trailing whitespace.
    private static func splitDocuments(_ yaml: String) -> [String] {
        var docs: [String] = []
        var current: [String] = []
        for line in yaml.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces) == "---" {
                docs.append(current.joined(separator: "\n"))
                current = []
            } else {
                current.append(line)
            }
        }
        docs.append(current.joined(separator: "\n"))
        return docs
    }

    /// True if `line` is a top-level (non-indented, column-0) mapping key named
    /// `key`, e.g. `apiVersion: v1`. Indented keys (nested under another) fail.
    private static func isTopLevelKey(_ line: String, _ key: String) -> Bool {
        // Top-level => no leading whitespace.
        guard line.first.map({ !$0.isWhitespace }) ?? false else { return false }
        let prefix = "\(key):"
        return line == key || line.hasPrefix(prefix)
    }
}
