import XCTest
@testable import Helmsman

/// Captures the last request and returns a canned response.
final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var lastURL: URL?
    nonisolated(unsafe) static var responseData: Data = Data()
    nonisolated(unsafe) static var statusCode: Int = 200

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubURLProtocol.lastURL = request.url
        let resp = HTTPURLResponse(url: request.url!, statusCode: StubURLProtocol.statusCode,
                                   httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: StubURLProtocol.responseData)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class SignalBridgeClientTests: XCTestCase {
    private func makeClient() -> SignalBridgeClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return SignalBridgeClient(localPort: 18099, session: URLSession(configuration: cfg))
    }

    func test_qrCodeURL_hitsQrcodelinkEndpoint() async throws {
        StubURLProtocol.responseData = Data([0x89, 0x50]) // pretend PNG bytes
        StubURLProtocol.statusCode = 200
        let data = try await makeClient().qrCodePNG()
        XCTAssertEqual(StubURLProtocol.lastURL?.host, "127.0.0.1")
        XCTAssertEqual(StubURLProtocol.lastURL?.port, 18099)
        XCTAssertEqual(StubURLProtocol.lastURL?.path, "/v1/qrcodelink")
        XCTAssertEqual(data, Data([0x89, 0x50]))
    }

    func test_accounts_decodesNumbers() async throws {
        StubURLProtocol.responseData = Data(#"["+15551234567"]"#.utf8)
        StubURLProtocol.statusCode = 200
        let accounts = try await makeClient().accounts()
        XCTAssertEqual(accounts, ["+15551234567"])
        XCTAssertEqual(StubURLProtocol.lastURL?.path, "/v1/accounts")
    }

    func test_accounts_emptyWhenNoneLinked() async throws {
        StubURLProtocol.responseData = Data("[]".utf8)
        StubURLProtocol.statusCode = 200
        let accounts = try await makeClient().accounts()
        XCTAssertTrue(accounts.isEmpty)
    }

    func test_sendTest_postsToV2Send() async throws {
        StubURLProtocol.responseData = Data("{}".utf8)
        StubURLProtocol.statusCode = 201
        try await makeClient().sendTest(number: "+1555", recipients: ["+1555"])
        XCTAssertEqual(StubURLProtocol.lastURL?.path, "/v2/send")
    }
}
