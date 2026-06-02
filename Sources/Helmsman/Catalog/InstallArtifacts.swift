import Foundation

/// One sensitive value the install needs, declared by Claude in a ```secrets
/// block. The wizard collects (or generates) the value and folds all of them
/// into a single Kubernetes Secret the installed app references.
struct SecretFieldSpec: Decodable, Identifiable, Equatable {
    enum Kind: String, Decodable { case random, user }

    let key: String          // Secret data key, must match what the manifest/chart references
    let label: String
    let description: String?
    let kind: Kind
    let length: Int?         // random only; default applied at generation time
    let required: Bool       // user fields gate Continue; defaults true

    var id: String { key }

    private enum CodingKeys: String, CodingKey { case key, label, description, kind, length, required }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(String.self, forKey: .label)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        kind = try c.decode(Kind.self, forKey: .kind)
        length = try c.decodeIfPresent(Int.self, forKey: .length)
        required = try c.decodeIfPresent(Bool.self, forKey: .required) ?? true
    }
}

/// How the app should be installed, declared by Claude in an ```install block.
struct InstallDescriptor: Decodable, Equatable {
    enum Mode: String, Decodable { case manifest, helm }

    let mode: Mode
    let repoName: String?
    let repoURL: String?
    let chart: String?
    let version: String?
    let releaseName: String?
}

/// Extracts the three artifacts Claude emits in the Generating step from one
/// assistant message. Mirrors `SuggestedAction.parse`'s fenced-block handling:
/// only CLOSED fences decode, so half-streamed JSON never decodes mid-write.
enum WizardArtifacts {
    static func parse(_ text: String) -> (yaml: String?, secrets: [SecretFieldSpec], install: InstallDescriptor?) {
        guard text.contains("```") else { return (nil, [], nil) }
        let parts = text.components(separatedBy: "```")
        var lastYAML: String? = nil
        var secrets: [SecretFieldSpec] = []
        var install: InstallDescriptor? = nil
        for (i, part) in parts.enumerated() {
            guard i % 2 == 1 else { continue }      // odd indices are inside a fence
            let isClosed = (i < parts.count - 1)
            guard isClosed else { continue }
            let (lang, body) = splitFence(part)
            switch lang {
            case "yaml", "yml":
                let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { lastYAML = trimmed }
            case "secrets":
                if let arr = try? JSONDecoder().decode([SecretFieldSpec].self, from: Data(body.utf8)) {
                    secrets = arr
                }
            case "install":
                if let one = try? JSONDecoder().decode(InstallDescriptor.self, from: Data(body.utf8)) {
                    install = one
                }
            default:
                break
            }
        }
        return (lastYAML, secrets, install)
    }

    private static func splitFence(_ part: String) -> (lang: String, body: String) {
        guard let nl = part.firstIndex(of: "\n") else {
            return (part.trimmingCharacters(in: .whitespaces).lowercased(), "")
        }
        let lang = part[..<nl].trimmingCharacters(in: .whitespaces).lowercased()
        return (lang, String(part[part.index(after: nl)...]))
    }
}
