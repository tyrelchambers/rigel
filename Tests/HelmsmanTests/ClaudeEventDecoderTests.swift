import XCTest
@testable import Helmsman

final class ClaudeEventDecoderTests: XCTestCase {
    private func decode(_ json: String) -> ClaudeEvent {
        ClaudeEventDecoder.decode(json.data(using: .utf8)!)
    }

    func test_systemInit_decodesSessionAndModel() {
        let e = decode(#"{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-8"}"#)
        guard case .systemInit(let sid, let model) = e else { return XCTFail("got \(e)") }
        XCTAssertEqual(sid, "s1")
        XCTAssertEqual(model, "claude-opus-4-8")
    }

    func test_streamEvent_textDelta() {
        let e = decode(#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}"#)
        guard case .textDelta(let t) = e else { return XCTFail("got \(e)") }
        XCTAssertEqual(t, "Hello")
    }

    func test_streamEvent_thinkingDelta() {
        let e = decode(#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Let me check"}}}"#)
        guard case .thinkingDelta(let t) = e else { return XCTFail("got \(e)") }
        XCTAssertEqual(t, "Let me check")
    }

    func test_streamEvent_otherDeltasAreSkipped() {
        let e = decode(#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#)
        guard case .unknown(let raw) = e else { return XCTFail("got \(e)") }
        XCTAssertEqual(raw, "")
    }

    func test_assistant_emitsToolUseOnly() {
        let json = #"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ignored"},{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"kubectl get pods"}}]}}"#
        let e = decode(json)
        guard case .toolUse(let id, let name, let input) = e else { return XCTFail("got \(e)") }
        XCTAssertEqual(id, "tu1")
        XCTAssertEqual(name, "Bash")
        XCTAssertEqual(input["command"] as? String, "kubectl get pods")
    }

    func test_assistant_textOnly_isSkipped() {
        let json = #"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}"#
        let e = decode(json)
        guard case .unknown(let raw) = e else { return XCTFail("got \(e)") }
        XCTAssertEqual(raw, "")
    }

    func test_result_decodesSessionAndCost() {
        let e = decode(#"{"type":"result","subtype":"success","session_id":"s1","total_cost_usd":0.002}"#)
        guard case .result(let sid, let cost) = e else { return XCTFail("got \(e)") }
        XCTAssertEqual(sid, "s1")
        XCTAssertEqual(cost ?? 0, 0.002, accuracy: 0.0001)
    }

    func test_result_usageLimit_decodesResetAt() {
        let epoch = 1_900_000_000
        let e = decode(#"{"type":"result","subtype":"error","is_error":true,"session_id":"s1","result":"Claude AI usage limit reached|\#(epoch)"}"#)
        guard case .usageLimit(let resetAt) = e else { return XCTFail("got \(e)") }
        XCTAssertEqual(resetAt, Date(timeIntervalSince1970: TimeInterval(epoch)))
    }

    func test_result_usageLimit_noEpoch_resetAtNil() {
        let e = decode(#"{"type":"result","subtype":"error","is_error":true,"result":"Claude AI usage limit reached"}"#)
        guard case .usageLimit(let resetAt) = e else { return XCTFail("got \(e)") }
        XCTAssertNil(resetAt)
    }

    func test_result_normal_isNotUsageLimit() {
        let e = decode(#"{"type":"result","subtype":"success","session_id":"s1","result":"all good","total_cost_usd":0.002}"#)
        guard case .result = e else { return XCTFail("got \(e)") }
    }

    func test_assistant_textUsageLimit_decodesUsageLimit() {
        let epoch = 1_900_000_000
        let json = #"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Claude AI usage limit reached|\#(epoch)"}]}}"#
        let e = decode(json)
        guard case .usageLimit(let resetAt) = e else { return XCTFail("got \(e)") }
        XCTAssertEqual(resetAt, Date(timeIntervalSince1970: TimeInterval(epoch)))
    }

    func test_malformedLine_isUnknownWithRaw() {
        let e = decode("not json")
        guard case .unknown(let raw) = e else { return XCTFail("got \(e)") }
        XCTAssertEqual(raw, "not json")
    }

    func test_buildArguments_includesPartialMessages() {
        let args = ClaudeSession.buildArguments(
            systemPrompt: "x",
            config: .default,
            allowedTools: [],
            mcpConfigPath: nil,
            resumingSessionId: nil
        )
        XCTAssertTrue(args.contains("--include-partial-messages"),
                      "expected --include-partial-messages in \(args)")
    }
}
