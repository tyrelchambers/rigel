import Foundation

/// Talks to a signal-cli-rest-api instance reached through the local end of a
/// `kubectl port-forward` (`http://127.0.0.1:<localPort>`).
struct SignalBridgeClient {
    let localPort: Int
    let session: URLSession

    init(localPort: Int, session: URLSession = .shared) {
        self.localPort = localPort
        self.session = session
    }

    enum ClientError: Error, CustomStringConvertible {
        case http(Int, String)   // status code + response body (the API explains 4xx here)
        case badResponse
        var description: String {
            switch self {
            case .http(let code, let body):
                return body.isEmpty ? "HTTP \(code)" : "HTTP \(code): \(body)"
            case .badResponse: return "unexpected response"
            }
        }
    }

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var c = URLComponents()
        c.scheme = "http"
        c.host = "127.0.0.1"
        c.port = localPort
        c.path = path
        if !query.isEmpty { c.queryItems = query }
        return c.url!
    }

    /// PNG bytes of the device-link QR code.
    func qrCodePNG(deviceName: String = "helmsman") async throws -> Data {
        let u = url("/v1/qrcodelink", query: [.init(name: "device_name", value: deviceName)])
        let (data, resp) = try await session.data(from: u)
        try check(resp, data)
        return data
    }

    /// Registered Signal numbers. Non-empty once a phone is linked.
    func accounts() async throws -> [String] {
        let (data, resp) = try await session.data(from: url("/v1/accounts"))
        try check(resp, data)
        return try JSONDecoder().decode([String].self, from: data)
    }

    /// Send a fixed test message to confirm the chain works end to end.
    func sendTest(number: String, recipients: [String]) async throws {
        var req = URLRequest(url: url("/v2/send"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "message": "✅ Helmsman test notification — Signal is wired up.",
            "number": number,
            "recipients": recipients,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        try check(resp, data)
    }

    private func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { throw ClientError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw ClientError.http(http.statusCode, body)
        }
    }
}
