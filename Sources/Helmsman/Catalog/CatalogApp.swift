import Foundation

/// Coarse buckets used by the catalog's category pill bar. The raw values
/// are what land in the bundled JSON.
enum AppCategory: String, Codable, CaseIterable, Hashable {
    case database
    case observability
    case productivity
    case devTools = "dev-tools"
    case media
    case network
    case other

    var displayName: String {
        switch self {
        case .database:      return "Database"
        case .observability: return "Observability"
        case .productivity:  return "Productivity"
        case .devTools:      return "Dev Tools"
        case .media:         return "Media"
        case .network:       return "Network"
        case .other:         return "Other"
        }
    }
}

/// Recommended baseline resources for one instance. Strings are Kubernetes
/// quantity literals so they can be substituted directly into the install
/// prompt template.
struct AppRequirements: Codable, Hashable {
    let cpuRequest: String
    let cpuLimit: String?
    let memoryRequest: String
    let memoryLimit: String?
    /// Persistent storage size in GiB. nil = stateless.
    let storageGiB: Int?
}

/// One entry in the bundled app catalog. The catalog is shipped with the
/// app — there's no remote fetch in v1.
struct CatalogApp: Codable, Identifiable, Hashable {
    /// Slug — also doubles as the default Helm-style instance name.
    let id: String
    let name: String
    let tagline: String
    /// Longer body shown in the detail sheet. Plain paragraphs; no rich
    /// markdown rendering in v1.
    let description: String
    let category: AppCategory
    /// SF Symbol name used as the card icon.
    let iconSystemName: String
    let docsURL: URL
    let repoURL: URL?
    let homepageURL: URL?
    let tags: [String]
    /// Distinctive container image repo path(s) that identify this app when
    /// found running in the cluster — the app's OWN image, never a shared
    /// dependency like `postgres`. Registry host and `:tag` are optional;
    /// install detection matches host- and tag-insensitively.
    let matchImages: [String]
    let requirements: AppRequirements
    /// True = needs a PVC; surfaces a "Storage" field in Configure.
    let persistence: Bool
    /// True = surfaces an "Ingress hostname" field in Configure.
    let exposesIngress: Bool
    /// Optional caveats / known gotchas surfaced in the detail sheet.
    let notes: String?
    /// Prompt sent verbatim to the wizard's `ClaudeSession`. Supports
    /// `{{instance}}`, `{{namespace}}`, `{{hostname}}`, `{{nodeName}}`,
    /// `{{storage}}`, `{{notes}}` placeholders.
    let installPromptTemplate: String
}

extension CatalogApp {
    /// Substitute the wizard's collected variables into the prompt template.
    /// Missing variables are left as the literal `{{var}}` placeholder so the
    /// gap surfaces in the rendered prompt rather than silently disappearing.
    func renderPrompt(vars: [String: String]) -> String {
        var out = installPromptTemplate
        for (key, value) in vars {
            out = out.replacingOccurrences(of: "{{\(key)}}", with: value)
        }
        return out
    }
}
