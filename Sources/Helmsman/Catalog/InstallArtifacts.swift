import Foundation

/// One sensitive value the install needs. Declared authoritatively in the
/// catalog entry's baked `install.secrets` schema (or, for not-yet-baked apps,
/// in a Claude-emitted ```secrets block). The wizard collects (or generates)
/// the value and folds all of them into the Secret the installed app references.
struct SecretFieldSpec: Codable, Identifiable, Hashable {
    enum Kind: String, Codable, Hashable { case random, user }

    let key: String          // Secret data key, must match what the manifest/chart references
    let label: String
    let description: String?
    let kind: Kind
    let length: Int?         // random only; default applied at generation time
    let format: RandomSecret.Format  // random only; charset for generated values
    let required: Bool       // user fields gate Continue; defaults true

    var id: String { key }

    private enum CodingKeys: String, CodingKey { case key, label, description, kind, length, format, required }

    init(key: String, label: String, description: String? = nil, kind: Kind, length: Int? = nil, format: RandomSecret.Format = .alphanumeric, required: Bool = true) {
        self.key = key
        self.label = label
        self.description = description
        self.kind = kind
        self.length = length
        self.format = format
        self.required = required
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(String.self, forKey: .label)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        kind = try c.decode(Kind.self, forKey: .kind)
        length = try c.decodeIfPresent(Int.self, forKey: .length)
        format = try c.decodeIfPresent(RandomSecret.Format.self, forKey: .format) ?? .alphanumeric
        required = try c.decodeIfPresent(Bool.self, forKey: .required) ?? true
    }
}

/// How an app installs. Declared authoritatively by the catalog (`CatalogApp.install`).
///
/// A "baked" entry also carries a parameterized install artifact (`manifest` for
/// manifest mode, `values` for helm mode) plus the typed `secrets` schema — all
/// produced once at add-time by the catalog-entry skill. When present, the wizard
/// installs deterministically (substitute `{{vars}}` + secret values, then apply)
/// with no Claude session. When absent, the wizard falls back to generating the
/// artifact from `CatalogApp.installPromptTemplate`.
struct InstallDescriptor: Codable, Equatable, Hashable {
    enum Mode: String, Codable, Hashable { case manifest, helm }

    let mode: Mode
    let repoName: String?
    let repoURL: String?
    let chart: String?
    let version: String?
    let releaseName: String?
    /// Baked, `{{var}}`-templated multi-doc manifest (manifest mode). nil ⇒ not baked.
    var manifest: String? = nil
    /// Baked, `{{var}}`-templated Helm values (helm mode). nil ⇒ not baked.
    var values: String? = nil
    /// Authoritative secret schema for the install. nil/empty ⇒ scan the artifact.
    var secrets: [SecretFieldSpec]? = nil
}

/// Extracts the three artifacts Claude emits in the Generating step from one
/// assistant message. Mirrors `SuggestedAction.parse`'s fenced-block handling:
/// only CLOSED fences decode, so half-streamed JSON never decodes mid-write.
enum WizardArtifacts {
    static func parse(_ text: String) -> (yaml: String?, secrets: [SecretFieldSpec]) {
        guard text.contains("```") else { return (nil, []) }
        let parts = text.components(separatedBy: "```")
        var lastYAML: String? = nil
        var secrets: [SecretFieldSpec] = []
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
            default:
                break
            }
        }
        return (lastYAML, secrets)
    }

    private static func splitFence(_ part: String) -> (lang: String, body: String) {
        guard let nl = part.firstIndex(of: "\n") else {
            return (part.trimmingCharacters(in: .whitespaces).lowercased(), "")
        }
        let lang = part[..<nl].trimmingCharacters(in: .whitespaces).lowercased()
        return (lang, String(part[part.index(after: nl)...]))
    }
}
