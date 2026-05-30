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

    enum ClientError: Error { case http(Int), badResponse }

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
        try check(resp)
        return data
    }

    /// Registered Signal numbers. Non-empty once a phone is linked.
    func accounts() async throws -> [String] {
        let (data, resp) = try await session.data(from: url("/v1/accounts"))
        try check(resp)
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
        let (_, resp) = try await session.data(for: req)
        try check(resp)
    }

    private func check(_ resp: URLResponse) throws {
        guard let http = resp as? HTTPURLResponse else { throw ClientError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw ClientError.http(http.statusCode) }
    }
}
