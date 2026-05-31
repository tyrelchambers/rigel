import XCTest
@testable import Helmsman

/// JSON-encode a string (with quotes) so it can be embedded as a value.
private func jsonString(_ s: String) -> String {
    String(data: try! JSONEncoder().encode(s), encoding: .utf8)!
}

final class ClaudeUpdateFallbackTests: XCTestCase {

    func test_parsesEnvelopeWithJSONArrayResult() {
        // `claude -p --output-format json` wraps the model text in `result`.
        let inner = #"[{"image":"vaultwarden/server:latest","current":"latest","latest":"1.32.0","hasUpdate":true}]"#
        let envelope = #"{"type":"result","result":\#(jsonString(inner))}"#
        let verdicts = ClaudeUpdateFallback.parse(Data(envelope.utf8))
        XCTAssertEqual(verdicts?["vaultwarden/server:latest"]?.hasUpdate, true)
        XCTAssertEqual(verdicts?["vaultwarden/server:latest"]?.latest, "1.32.0")
    }

    func test_toleratesProseAndCodeFenceAroundArray() {
        let result = "Here you go:\n```json\n[{\"image\":\"x:1\",\"current\":\"1\",\"latest\":null,\"hasUpdate\":false}]\n```"
        let envelope = #"{"result":\#(jsonString(result))}"#
        let verdicts = ClaudeUpdateFallback.parse(Data(envelope.utf8))
        XCTAssertEqual(verdicts?["x:1"]?.hasUpdate, false)
    }

    func test_returnsNilOnGarbage() {
        XCTAssertNil(ClaudeUpdateFallback.parse(Data("not json".utf8)))
    }

    func test_resolveMapsVerdictsBackToAppIDs() async {
        let items = [
            InstalledImage(appID: "vw", image: "vaultwarden/server:latest"),
            InstalledImage(appID: "n8n", image: "n8nio/n8n:latest"),
        ]
        let stub = ClaudeUpdateFallback(runClaude: { _ in
            let arr = #"[{"image":"vaultwarden/server:latest","current":"latest","latest":"1.32.0","hasUpdate":true},"# +
                      #"{"image":"n8nio/n8n:latest","current":"latest","latest":"1.70.0","hasUpdate":false}]"#
            return Data(#"{"result":\#(jsonString(arr))}"#.utf8)
        })
        let out = await stub.resolve(items)
        XCTAssertEqual(out["vw"], .updateAvailable(current: "latest", latest: "1.32.0"))
        XCTAssertEqual(out["n8n"], .upToDate(current: "latest"))
    }

    func test_resolveDegradesToUnknownWhenClaudeFails() async {
        let items = [InstalledImage(appID: "vw", image: "vaultwarden/server:latest")]
        let stub = ClaudeUpdateFallback(runClaude: { _ in throw ClaudeUpdateFallback.ClaudeFallbackError.claudeNotFound })
        let out = await stub.resolve(items)
        if case .unknown = out["vw"] {} else { XCTFail("expected unknown, got \(String(describing: out["vw"]))") }
    }
}
