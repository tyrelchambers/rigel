import Foundation

enum ClaudeEvent {
    case systemInit(sessionId: String, model: String?)
    case textDelta(String)
    case thinkingDelta(String)
    case toolUse(id: String, name: String, input: [String: Any])
    case result(sessionId: String, costUSD: Double?)
    /// The subscription usage limit was hit this turn. `resetAt` is the parsed
    /// reset time when the canonical message carried a `|<epoch>`, else nil.
    case usageLimit(resetAt: Date?)
    /// Lines we don't surface. `raw` is non-empty only for genuine diagnostics
    /// (malformed JSON, stderr); recognized-but-ignored events carry "".
    case unknown(raw: String)
}

enum ClaudeEventDecoder {
    /// Best-effort decode a single stream-json line into a ClaudeEvent.
    /// Tolerant of schema drift: unknown shapes return .unknown(raw:).
    static func decode(_ line: Data) -> ClaudeEvent {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            return .unknown(raw: String(data: line, encoding: .utf8) ?? "")
        }
        let type = (obj["type"] as? String) ?? ""
        let subtype = (obj["subtype"] as? String) ?? ""

        switch (type, subtype) {
        case ("system", "init"):
            return .systemInit(
                sessionId: (obj["session_id"] as? String) ?? "",
                model: obj["model"] as? String
            )

        case ("stream_event", _):
            return decodeStreamEvent(obj["event"] as? [String: Any])

        case ("assistant", _):
            // Text streams via deltas; use the consolidated message only for tool_use.
            let message = obj["message"] as? [String: Any]
            let content = message?["content"] as? [[String: Any]] ?? []
            for block in content where (block["type"] as? String) == "tool_use" {
                if let id = block["id"] as? String, let name = block["name"] as? String {
                    let input = (block["input"] as? [String: Any]) ?? [:]
                    return .toolUse(id: id, name: name, input: input)
                }
            }
            // The usage-limit string can also ride a consolidated assistant text
            // block. (Detected here too, by approved decision — we can't confirm
            // the exact channel against a real limited response.)
            for block in content where (block["type"] as? String) == "text" {
                if let text = block["text"] as? String, let resetAt = parseUsageLimit(text) {
                    return .usageLimit(resetAt: resetAt)
                }
            }
            return .unknown(raw: "")

        case ("result", _):
            if let resultText = obj["result"] as? String,
               let resetAt = parseUsageLimit(resultText) {
                return .usageLimit(resetAt: resetAt)
            }
            return .result(
                sessionId: (obj["session_id"] as? String) ?? "",
                costUSD: obj["total_cost_usd"] as? Double
            )

        default:
            return .unknown(raw: String(data: line, encoding: .utf8) ?? "")
        }
    }

    /// Detect the canonical subscription-usage-limit string
    /// `Claude AI usage limit reached|<epoch-seconds>` in `text`. Returns nil
    /// when the marker is absent; when present, `.some(resetAt)` carries the
    /// parsed reset time (itself nil when there is no parseable `|<epoch>`).
    private static func parseUsageLimit(_ text: String) -> Date?? {
        guard text.lowercased().contains("claude ai usage limit reached") else { return nil }
        let resetAt = text.split(separator: "|").last
            .flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }
            .map { Date(timeIntervalSince1970: TimeInterval($0)) }
        return .some(resetAt)
    }

    /// Pull text/thinking out of a raw Anthropic SSE `content_block_delta`.
    /// Every other partial-message event is recognized-but-ignored ("").
    private static func decodeStreamEvent(_ event: [String: Any]?) -> ClaudeEvent {
        guard let event, (event["type"] as? String) == "content_block_delta",
              let delta = event["delta"] as? [String: Any] else {
            return .unknown(raw: "")
        }
        switch delta["type"] as? String {
        case "text_delta":
            return .textDelta((delta["text"] as? String) ?? "")
        case "thinking_delta":
            return .thinkingDelta((delta["thinking"] as? String) ?? "")
        default:
            return .unknown(raw: "")
        }
    }
}
