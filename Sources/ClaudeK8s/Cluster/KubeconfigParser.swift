import Foundation
import Yams

struct KubeContext: Hashable, Identifiable {
    let name: String
    let cluster: String
    let user: String
    let namespace: String?
    var id: String { name }
}

struct Kubeconfig {
    let currentContext: String?
    let contexts: [KubeContext]
}

enum KubeconfigParser {
    enum ParseError: Error { case malformed(String) }

    static func parse(_ yaml: String) throws -> Kubeconfig {
        guard let root = try Yams.load(yaml: yaml) as? [String: Any] else {
            throw ParseError.malformed("top-level not a map")
        }
        let current = root["current-context"] as? String
        let entries = (root["contexts"] as? [[String: Any]]) ?? []

        let contexts: [KubeContext] = entries.compactMap { entry in
            guard let name = entry["name"] as? String,
                  let inner = entry["context"] as? [String: Any],
                  let cluster = inner["cluster"] as? String,
                  let user = inner["user"] as? String else { return nil }
            return KubeContext(
                name: name,
                cluster: cluster,
                user: user,
                namespace: inner["namespace"] as? String
            )
        }
        return Kubeconfig(currentContext: current, contexts: contexts)
    }

    static func loadDefault() throws -> Kubeconfig {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let path = home.appendingPathComponent(".kube/config")
        let yaml = try String(contentsOf: path)
        return try parse(yaml)
    }
}
