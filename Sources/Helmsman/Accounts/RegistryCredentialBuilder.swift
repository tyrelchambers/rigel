import Foundation

/// Builds the `.dockerconfigjson` payload for a registry pull Secret. Pure — holds
/// no state and performs no I/O. Encodes the well-known Docker Hub quirk that its
/// auths key is `https://index.docker.io/v1/`, not `docker.io`.
enum RegistryCredentialBuilder {
    static func authsKey(for registry: String) -> String {
        let r = registry.trimmingCharacters(in: .whitespaces).lowercased()
        if r.isEmpty || r == "docker.io" || r == "index.docker.io" || r == "registry-1.docker.io" {
            return "https://index.docker.io/v1/"
        }
        return r
    }

    /// `{"auths":{"<key>":{"username":..,"password":..,"auth":base64("user:token")}}}`.
    /// Sorted keys for deterministic output (testability).
    static func dockerConfigJSON(registry: String, username: String, token: String) -> String {
        let auth = Data("\(username):\(token)".utf8).base64EncodedString()
        let entry: [String: String] = ["username": username, "password": token, "auth": auth]
        let payload: [String: [String: [String: String]]] = ["auths": [authsKey(for: registry): entry]]
        // try! is correct here: payload is a statically-typed [String:[String:[String:String]]]
        // of pure String values, which JSONSerialization can always serialize.
        let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        // String(decoding:as:) never returns nil and never throws.
        return String(decoding: data, as: UTF8.self)
    }
}
