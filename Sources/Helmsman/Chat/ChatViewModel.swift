import Foundation
import Observation

struct ChatMessage: Identifiable {
    let id = UUID()
    let role: Role
    var text: String
    var tool: ToolInvocation? = nil

    enum Role { case user, assistant, system }
}

struct ToolInvocation {
    let toolUseId: String
    let name: String
    /// JSON-serialized representation of the tool's input arguments.
    let inputJSON: String
    /// Extracted convenience fields when the tool is Bash.
    let bashCommand: String?
    let bashDescription: String?
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
    private var currentContext: String?
    /// In-flight history entry id. Set when the first user message lands, used
    /// to upsert into SessionStore.history as the conversation grows.
    private(set) var historyEntryId: UUID? = nil
    /// Text of the most recent user message, used by the ↑-arrow recall in the input.
    private(set) var lastUserMessage: String? = nil

    func start(resumingSessionId: String? = nil, clusterContext: String? = nil) {
        // Idempotent: skip restart if already running for this context.
        if session != nil && clusterContext == currentContext {
            return
        }
        stop()
        currentContext = clusterContext
        do {
            let s = try ClaudeSession(resumingSessionId: resumingSessionId, clusterContext: clusterContext)
            self.session = s
            self.sessionId = resumingSessionId
            let ctx = clusterContext
            let hadResume = (resumingSessionId != nil)
            pumpTask = Task { [weak self] in
                let eventStream = await s.start()
                // Local — captures whether THIS task saw real output, so a
                // pumpTask from a replaced session can never poison the new
                // session's state.
                var sawRealOutput = false
                for await event in eventStream {
                    switch event {
                    case .assistantText(let chunk):
                        if !chunk.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            sawRealOutput = true
                        }
                    case .result:
                        sawRealOutput = true
                    default: break
                    }
                    await self?.handle(event)
                }
                // Cleanup only fires if we're still the active session — if
                // startNewChat() / resumeHistory() has swapped us out, leave
                // the new session alone.
                await MainActor.run {
                    guard let self else { return }
                    guard self.session === s else { return }
                    self.session = nil
                    if !sawRealOutput, hadResume, let ctx {
                        SessionStore.shared.clearSessionId(for: ctx)
                        self.sessionId = nil
                        self.messages.append(ChatMessage(role: .system, text: "⚠︎ Saved session was stale — cleared. Restart the app to start fresh."))
                    }
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
        lastUserMessage = text
        isStreaming = true
        saveActiveToHistory()
        Task { [weak self] in
            do {
                try await session.send(text)
            } catch {
                await MainActor.run {
                    self?.isStreaming = false
                    self?.error = "Claude session ended: \(error). Restart the app to start a new one."
                    self?.messages.append(ChatMessage(role: .system, text: "⚠︎ Claude subprocess is no longer running. Message not sent."))
                }
            }
        }
    }

    /// Send a prebuilt context-handoff prompt (e.g. "Ask Claude about this pod").
    func sendHandoff(_ prompt: String) {
        send(prompt)
    }

    func clear() {
        messages.removeAll()
    }

    func appendSystem(_ text: String) {
        messages.append(ChatMessage(role: .system, text: text))
    }

    /// Interrupt the in-progress reply. Session stays alive — next send picks
    /// up where this left off (minus the aborted turn).
    func interrupt() {
        guard let session else { return }
        Task { await session.interrupt() }
        isStreaming = false
        messages.append(ChatMessage(role: .system, text: "⏹ Stopped by user."))
    }

    /// End the current chat, save it to history, and start fresh.
    func startNewChat(clusterContext: String?) {
        saveActiveToHistory()
        let ctx = clusterContext ?? currentContext
        if let ctx { SessionStore.shared.clearSessionId(for: ctx) }
        stop()
        messages.removeAll()
        sessionId = nil
        error = nil
        historyEntryId = nil
        currentContext = nil   // force re-start
        start(resumingSessionId: nil, clusterContext: ctx)
    }

    /// Resume a saved history entry: discard the active session and load the
    /// recorded messages + claude session id.
    func resumeHistory(_ entry: ChatHistoryEntry) {
        saveActiveToHistory()
        stop()
        messages = entry.messages.map { p in
            ChatMessage(role: roleFromString(p.role), text: p.text)
        }
        sessionId = entry.sessionId
        error = nil
        historyEntryId = entry.id
        currentContext = nil
        start(resumingSessionId: entry.sessionId, clusterContext: entry.context)
    }

    private func roleFromString(_ s: String) -> ChatMessage.Role {
        switch s {
        case "user":      return .user
        case "assistant": return .assistant
        default:          return .system
        }
    }

    /// Snapshot current conversation into SessionStore.history. Called on
    /// every meaningful message and when starting a new chat.
    private func saveActiveToHistory() {
        // Only save if there's at least one user message.
        guard let userMessage = messages.first(where: { $0.role == .user }) else { return }
        let ctx = currentContext ?? "default"
        let id = historyEntryId ?? UUID()
        historyEntryId = id
        let title = String(userMessage.text.prefix(80))
        let now = Date()
        let entry = ChatHistoryEntry(
            id: id,
            context: ctx,
            sessionId: sessionId,
            createdAt: SessionStore.shared.history.first(where: { $0.id == id })?.createdAt ?? now,
            updatedAt: now,
            title: title,
            messages: messages.map { PersistedMessage(role: roleString($0.role), text: $0.text) }
        )
        SessionStore.shared.upsertHistory(entry)
    }

    private func roleString(_ r: ChatMessage.Role) -> String {
        switch r { case .user: return "user"; case .assistant: return "assistant"; case .system: return "system" }
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
            saveActiveToHistory()
        case .assistantText(let chunk):
            guard !chunk.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { break }
            if var last = messages.last, last.role == .assistant, last.tool == nil {
                last.text += chunk
                messages[messages.count - 1] = last
            } else {
                messages.append(ChatMessage(role: .assistant, text: chunk))
            }
        case .toolUse(let id, let name, let input):
            let pretty = (try? JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted]))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            let tool = ToolInvocation(
                toolUseId: id,
                name: name,
                inputJSON: pretty,
                bashCommand: input["command"] as? String,
                bashDescription: input["description"] as? String
            )
            messages.append(ChatMessage(role: .system, text: "", tool: tool))
        case .permissionRequest(let toolUseId, let toolName, let input):
            let desc = (try? String(data: JSONSerialization.data(withJSONObject: input), encoding: .utf8)) ?? "{}"
            pendingPermission = PendingPermission(toolUseId: toolUseId, toolName: toolName, inputDescription: desc)
        case .result:
            isStreaming = false
            saveActiveToHistory()
        case .unknown(let raw):
            // Surface diagnostic strings (e.g. terminationHandler stderr) but skip
            // genuine JSON we don't recognize — those are stream-format noise.
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("{") else { return }
            messages.append(ChatMessage(role: .system, text: "⚠︎ \(trimmed)"))
        }
    }
}
