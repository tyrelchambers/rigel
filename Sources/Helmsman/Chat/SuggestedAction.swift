import Foundation

/// A cluster mutation Claude offers as a one-click button. Parsed from a fenced
/// ```action JSON block in an assistant message, then mapped to a typed
/// `WorkloadAction` (resolved against the live cache) and run through the app's
/// own confirm → kubectl path — so it is gated by the app's confirm sheet, not
/// Claude's auto-mode tool classifier.
struct SuggestedAction: Identifiable, Decodable {
    enum Kind: String, Decodable {
        case restart, scale, rollback, setEnv, setImage, deletePod, cordon, uncordon
    }

    let id: UUID
    let label: String
    let kind: Kind
    var deployment: String?
    var pod: String?
    var node: String?
    var namespace: String?
    var replicas: Int?
    var env: [String: String]?
    /// Container name to retag (setImage only).
    var container: String?
    /// Full target image reference, e.g. `repo:newtag` (setImage only).
    var image: String?

    private enum CodingKeys: String, CodingKey {
        case label, kind, deployment, pod, node, namespace, replicas, env, container, image
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = UUID()
        self.label = try c.decode(String.self, forKey: .label)
        self.kind = try c.decode(Kind.self, forKey: .kind)
        self.deployment = try c.decodeIfPresent(String.self, forKey: .deployment)
        self.pod = try c.decodeIfPresent(String.self, forKey: .pod)
        self.node = try c.decodeIfPresent(String.self, forKey: .node)
        self.namespace = try c.decodeIfPresent(String.self, forKey: .namespace)
        self.replicas = try c.decodeIfPresent(Int.self, forKey: .replicas)
        self.env = try c.decodeIfPresent([String: String].self, forKey: .env)
        self.container = try c.decodeIfPresent(String.self, forKey: .container)
        self.image = try c.decodeIfPresent(String.self, forKey: .image)
    }

    var systemImage: String {
        switch kind {
        case .restart:   return "arrow.clockwise"
        case .scale:     return "arrow.up.arrow.down"
        case .rollback:  return "arrow.uturn.backward"
        case .setEnv:    return "slider.horizontal.3"
        case .setImage:  return "shippingbox.and.arrow.backward"
        case .deletePod: return "trash"
        case .cordon:    return "nosign"
        case .uncordon:  return "checkmark.circle"
        }
    }

    /// Split an assistant message into the prose to display and the actions to
    /// surface as buttons. Fenced ```action blocks are removed from `display`;
    /// each one's JSON (a single object or an array) is decoded into actions.
    /// Unterminated trailing ```action fences (mid-stream) are dropped from
    /// display and yield no actions until they close, so half-written JSON
    /// never flashes in the transcript. Other code fences are left intact.
    static func parse(from text: String) -> (display: String, actions: [SuggestedAction]) {
        guard text.contains("```") else { return (text, []) }
        let parts = text.components(separatedBy: "```")
        var display = ""
        var actions: [SuggestedAction] = []
        for (i, part) in parts.enumerated() {
            let insideFence = (i % 2 == 1)
            guard insideFence else { display += part; continue }
            let isClosed = (i < parts.count - 1)
            let (lang, body) = splitFence(part)
            if lang == "action" {
                if isClosed { actions.append(contentsOf: decode(body)) }
                // closed or still-open action fence → contributes nothing to display
            } else if isClosed {
                display += "```\(part)```"
            } else {
                display += "```\(part)"
            }
        }
        return (display.trimmingCharacters(in: .whitespacesAndNewlines), actions)
    }

    private static func splitFence(_ part: String) -> (lang: String, body: String) {
        guard let nl = part.firstIndex(of: "\n") else {
            return (part.trimmingCharacters(in: .whitespaces).lowercased(), "")
        }
        let lang = part[..<nl].trimmingCharacters(in: .whitespaces).lowercased()
        return (lang, String(part[part.index(after: nl)...]))
    }

    private static func decode(_ json: String) -> [SuggestedAction] {
        let data = Data(json.utf8)
        let decoder = JSONDecoder()
        if let arr = try? decoder.decode([SuggestedAction].self, from: data) { return arr }
        if let one = try? decoder.decode(SuggestedAction.self, from: data) { return [one] }
        return []
    }
}
