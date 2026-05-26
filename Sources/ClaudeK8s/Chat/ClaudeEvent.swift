import Foundation

enum ClaudeEvent {
    case systemInit(sessionId: String, model: String?)
    case assistantText(text: String)
    case toolUse(id: String, name: String, input: [String: Any])
    case permissionRequest(toolUseId: String, toolName: String, input: [String: Any])
    case result(sessionId: String, costUSD: Double?)
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

        case ("assistant", _):
            let message = obj["message"] as? [String: Any]
            let content = message?["content"] as? [[String: Any]] ?? []
            // Concatenate any text blocks; surface tool_use separately.
            var text = ""
            var toolUses: [ClaudeEvent] = []
            for block in content {
                let bt = block["type"] as? String
                if bt == "text", let t = block["text"] as? String { text += t }
                else if bt == "tool_use",
                        let id = block["id"] as? String,
                        let name = block["name"] as? String {
                    let input = (block["input"] as? [String: Any]) ?? [:]
                    toolUses.append(.toolUse(id: id, name: name, input: input))
                }
            }
            if !toolUses.isEmpty, text.isEmpty {
                return toolUses[0]
            } else {
                return .assistantText(text: text)
            }

        case ("result", _):
            return .result(
                sessionId: (obj["session_id"] as? String) ?? "",
                costUSD: obj["total_cost_usd"] as? Double
            )

        case ("permission_request", _):
            return .permissionRequest(
                toolUseId: (obj["tool_use_id"] as? String) ?? "",
                toolName: (obj["tool_name"] as? String) ?? "",
                input: (obj["input"] as? [String: Any]) ?? [:]
            )

        default:
            return .unknown(raw: String(data: line, encoding: .utf8) ?? "")
        }
    }
}
