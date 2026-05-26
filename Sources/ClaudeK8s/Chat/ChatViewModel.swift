import Foundation
import Observation

struct ChatMessage: Identifiable {
    let id = UUID()
    let role: Role
    var text: String

    enum Role { case user, assistant, system }
}

struct PendingPermission: Identifiable {
    let id = UUID()
    let toolUseId: String
    let toolName: String
    let inputDescription: String
}

@MainActor
@Observable
final class ChatViewModel {
    var messages: [ChatMessage] = []
    var inputText: String = ""
    var isStreaming = false
    var pendingPermission: PendingPermission? = nil
    var sessionId: String? = nil
    var error: String? = nil

    private var session: ClaudeSession?
    private var pumpTask: Task<Void, Never>?

    func start(resumingSessionId: String? = nil) {
        stop()
        do {
            let s = try ClaudeSession(resumingSessionId: resumingSessionId)
            self.session = s
            self.sessionId = resumingSessionId
            pumpTask = Task { [weak self] in
                let eventStream = await s.start()
                for await event in eventStream {
                    await self?.handle(event)
                }
            }
        } catch {
            self.error = "\(error)"
        }
    }

    func stop() {
        pumpTask?.cancel()
        pumpTask = nil
        Task { await session?.terminate() }
        session = nil
    }

    /// Send a free-form user message.
    func send(_ text: String) {
        guard let session else { return }
        messages.append(ChatMessage(role: .user, text: text))
        isStreaming = true
        Task { try? await session.send(text) }
    }

    /// Send a prebuilt context-handoff prompt (e.g. "Ask Claude about this pod").
    func sendHandoff(_ prompt: String) {
        send(prompt)
    }

    func answerPermission(allow: Bool) {
        guard let pending = pendingPermission, let session else { return }
        self.pendingPermission = nil
        Task { try? await session.answerPermission(toolUseId: pending.toolUseId, allow: allow) }
    }

    func handle(_ event: ClaudeEvent) {
        switch event {
        case .systemInit(let sid, _):
            sessionId = sid
        case .assistantText(let chunk):
            if var last = messages.last, last.role == .assistant {
                last.text += chunk
                messages[messages.count - 1] = last
            } else {
                messages.append(ChatMessage(role: .assistant, text: chunk))
            }
        case .toolUse(let id, let name, let input):
            let desc = (try? String(data: JSONSerialization.data(withJSONObject: input), encoding: .utf8)) ?? "{}"
            messages.append(ChatMessage(role: .system, text: "🔧 tool: \(name) (id=\(id))\n\(desc.prefix(200))"))
        case .permissionRequest(let toolUseId, let toolName, let input):
            let desc = (try? String(data: JSONSerialization.data(withJSONObject: input), encoding: .utf8)) ?? "{}"
            pendingPermission = PendingPermission(toolUseId: toolUseId, toolName: toolName, inputDescription: desc)
        case .result:
            isStreaming = false
        case .unknown:
            break
        }
    }
}
