import Foundation

enum ClaudeSessionError: Error, CustomStringConvertible {
    case claudeNotFound
    case notRunning
    var description: String {
        switch self {
        case .claudeNotFound: return "claude not found on PATH (install Claude Code CLI first)"
        case .notRunning: return "claude process is not running"
        }
    }
}

actor ClaudeSession {
    let binaryPath: String
    private var proc: Process?
    private var stdinPipe: Pipe?
    private var continuation: AsyncStream<ClaudeEvent>.Continuation?
    var sessionId: String?

    init(resumingSessionId: String? = nil) throws {
        guard let path = resolveBinary("claude") else {
            throw ClaudeSessionError.claudeNotFound
        }
        self.binaryPath = path
        self.sessionId = resumingSessionId
    }

    /// Start the subprocess. Returns an AsyncStream of events.
    func start() -> AsyncStream<ClaudeEvent> {
        AsyncStream { (cont: AsyncStream<ClaudeEvent>.Continuation) in
            self.continuation = cont

            let p = Process()
            p.executableURL = URL(fileURLWithPath: binaryPath)
            var args = ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose"]
            if let sid = sessionId { args.append(contentsOf: ["--resume", sid]) }
            p.arguments = args

            let outPipe = Pipe()
            let errPipe = Pipe()
            let inPipe = Pipe()
            p.standardOutput = outPipe
            p.standardError = errPipe
            p.standardInput = inPipe
            self.stdinPipe = inPipe

            var parser = StreamJsonParser()
            outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let chunk = handle.availableData
                guard !chunk.isEmpty else { return }
                parser.feed(chunk) { line in
                    let event = ClaudeEventDecoder.decode(line)
                    if case .systemInit(let sid, _) = event {
                        Task { await self?.recordSessionId(sid) }
                    }
                    cont.yield(event)
                }
            }

            p.terminationHandler = { _ in
                outPipe.fileHandleForReading.readabilityHandler = nil
                cont.finish()
            }

            do {
                try p.run()
                self.proc = p
            } catch {
                cont.finish()
            }

            cont.onTermination = { [weak self] _ in
                Task { await self?.terminate() }
            }
        }
    }

    private func recordSessionId(_ sid: String) {
        self.sessionId = sid
    }

    /// Send a user message as stream-json input.
    func send(_ userText: String) throws {
        guard let pipe = stdinPipe else { throw ClaudeSessionError.notRunning }
        let payload: [String: Any] = [
            "type": "user",
            "message": [
                "role": "user",
                "content": [["type": "text", "text": userText]]
            ]
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        pipe.fileHandleForWriting.write(data)
        pipe.fileHandleForWriting.write(Data("\n".utf8))
    }

    /// Approve or deny a pending permission request.
    func answerPermission(toolUseId: String, allow: Bool) throws {
        guard let pipe = stdinPipe else { throw ClaudeSessionError.notRunning }
        let payload: [String: Any] = [
            "type": "permission_decision",
            "tool_use_id": toolUseId,
            "decision": allow ? "allow" : "deny"
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        pipe.fileHandleForWriting.write(data)
        pipe.fileHandleForWriting.write(Data("\n".utf8))
    }

    func terminate() {
        if let p = proc, p.isRunning { p.terminate() }
        try? stdinPipe?.fileHandleForWriting.close()
        proc = nil
    }
}
