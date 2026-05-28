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
    /// Read-only kubectl patterns that bypass the PermissionSheet.
    /// Anything not in this list still goes through the user-approval modal.
    static let readOnlyKubectlAllowlist: [String] = [
        "Bash(kubectl get *)",
        "Bash(kubectl describe *)",
        "Bash(kubectl logs *)",
        "Bash(kubectl top *)",
        "Bash(kubectl events *)",
        "Bash(kubectl explain *)",
        "Bash(kubectl version*)",
        "Bash(kubectl cluster-info*)",
        "Bash(kubectl api-resources*)",
        "Bash(kubectl api-versions*)",
        "Bash(kubectl auth can-i *)",
        "Bash(kubectl config get-contexts*)",
        "Bash(kubectl config current-context*)",
        "Bash(kubectl config view*)",
    ]

    let binaryPath: String
    let clusterContext: String?
    private var proc: Process?
    private var stdinPipe: Pipe?
    private var continuation: AsyncStream<ClaudeEvent>.Continuation?
    var sessionId: String?

    init(resumingSessionId: String? = nil, clusterContext: String? = nil) throws {
        guard let path = resolveBinary("claude") else {
            throw ClaudeSessionError.claudeNotFound
        }
        self.binaryPath = path
        self.sessionId = resumingSessionId
        self.clusterContext = clusterContext
    }

    /// If the bundled MCP server binary is sitting next to this executable
    /// (i.e. we're running from a .app), write a one-time mcp-config JSON file
    /// pointing at it and return the path. Returns nil when the binary isn't
    /// present (e.g. `swift run` from the SPM repo) — caller should degrade
    /// without MCP in that case.
    private static func writeMCPConfigIfAvailable() -> String? {
        let exePath = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let mcpBinary = (exePath as NSString).deletingLastPathComponent + "/HelmsmanMCP"
        guard FileManager.default.isExecutableFile(atPath: mcpBinary) else { return nil }

        let config: [String: Any] = [
            "mcpServers": [
                "helmsman": [
                    "command": mcpBinary,
                    "args": [String](),
                ],
            ],
        ]
        let supportDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("com.tyrelchambers.helmsman", isDirectory: true)
        guard let supportDir else { return nil }
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        let configURL = supportDir.appendingPathComponent("mcp-config.json")
        guard let data = try? JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted]) else { return nil }
        do {
            try data.write(to: configURL, options: .atomic)
            return configURL.path
        } catch {
            return nil
        }
    }

    private func systemPrompt() -> String {
        let ctxLine = clusterContext.map { "Active kubectl context: `\($0)`. Always pass `--context \($0)` to kubectl so commands hit the right cluster." }
            ?? "No specific kubectl context is selected — use the user's current-context."
        return """
        You are running inside the Helmsman desktop app — a Kubernetes admin tool the user uses to investigate and manage their cluster.

        \(ctxLine)

        INVESTIGATE BEFORE ANSWERING. When the user asks about cluster state, prefer the **mcp__helmsman__** tools — they're purpose-built and structured:
        - `list_unhealthy_pods` — start here for "what's broken" / "what's down" type questions
        - `list_degraded_deployments` — deployments not at desired replica count
        - `recent_warning_events` — recent Warning events, optionally per namespace
        - `get_pod_logs` — recent logs for a specific pod

        Fall back to Bash kubectl for anything the MCP tools don't cover. These are pre-approved — do not ask permission, just run them:
        - kubectl get / describe / logs / top / events / explain
        - kubectl version / cluster-info / api-resources / api-versions
        - kubectl auth can-i ...
        - kubectl config get-contexts / current-context / view

        Anything destructive (apply, create, delete, patch, edit, replace, scale, rollout, drain, cordon, uncordon, exec, port-forward, cp) is NOT pre-approved. The app will show the user a permission modal when you invoke it. Briefly say what you intend before calling.

        SUGGEST ACTIONS AS BUTTONS — don't run mutations yourself. For any change to the cluster (restart, scale, rollback, set env, delete a pod, cordon/uncordon a node), DO NOT call kubectl yourself and DO NOT ask the user to type "yes". Instead append a fenced ```action block. The app hides the raw block and renders a one-click button that runs the change through its own confirm dialog (so it is never blocked by the auto-mode tool classifier). Still explain in prose what the action does and why.

        The block is JSON — a single object or an array of objects. Schema (include only the fields the kind needs; always set `namespace`):
        - `label`: short imperative button text, e.g. "Set MEMOS_PORT=5230 & restart memos"
        - `kind`: one of restart | scale | rollback | setEnv | deletePod | cordon | uncordon
        - `deployment`: name (for restart/scale/rollback/setEnv)
        - `pod`: name (for deletePod)
        - `node`: name (for cordon/uncordon)
        - `namespace`: defaults to "default"
        - `replicas`: integer (scale only)
        - `env`: object of KEY:VALUE strings (setEnv only)

        Example — fixing a deployment listening on the wrong port:
        ```action
        {"label":"Set MEMOS_PORT=5230 & restart memos","kind":"setEnv","deployment":"memos","namespace":"default","env":{"MEMOS_PORT":"5230"}}
        ```
        Only suggest actions the user can act on now; offer 1–3 at a time. Keep read-only investigation in your normal tool calls.

        Prefer `-o json` and pipe through `jq` when you need structured fields. Keep answers grounded in real command output, not assumptions.
        """
    }

    /// Start the subprocess. Returns an AsyncStream of events.
    func start() -> AsyncStream<ClaudeEvent> {
        AsyncStream { (cont: AsyncStream<ClaudeEvent>.Continuation) in
            self.continuation = cont

            let p = Process()
            p.executableURL = URL(fileURLWithPath: binaryPath)
            var args: [String] = [
                "--output-format", "stream-json",
                "--input-format", "stream-json",
                "--verbose",
                "--append-system-prompt", systemPrompt(),
            ]
            for pattern in Self.readOnlyKubectlAllowlist {
                args.append(contentsOf: ["--allowedTools", pattern])
            }
            // Wire up our embedded MCP server (only when running from a .app bundle
            // with the binary alongside — `swift run` won't have it and degrades).
            if let mcpConfigPath = ClaudeSession.writeMCPConfigIfAvailable() {
                args.append(contentsOf: ["--mcp-config", mcpConfigPath])
                args.append(contentsOf: ["--allowedTools",
                    "mcp__helmsman__list_unhealthy_pods",
                    "mcp__helmsman__list_degraded_deployments",
                    "mcp__helmsman__recent_warning_events",
                    "mcp__helmsman__get_pod_logs",
                ])
            }
            if let sid = sessionId { args.append(contentsOf: ["--resume", sid]) }
            p.arguments = args

            // Forward the active context to the MCP subprocess via env so its
            // kubectl invocations target the right cluster.
            var env = ProcessInfo.processInfo.environment
            if let ctx = clusterContext { env["CLAUDEK8S_CONTEXT"] = ctx }
            p.environment = env

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

            let errBox = OutputBox()
            errPipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty {
                    handle.readabilityHandler = nil
                } else {
                    errBox.append(chunk)
                }
            }

            p.terminationHandler = { [weak self] p in
                outPipe.fileHandleForReading.readabilityHandler = nil
                errPipe.fileHandleForReading.readabilityHandler = nil
                let stderr = String(data: errBox.data, encoding: .utf8) ?? ""
                if p.terminationStatus != 0 || !stderr.isEmpty {
                    let msg = "claude exited (\(p.terminationStatus)): \(stderr.prefix(500))"
                    cont.yield(.unknown(raw: msg))
                }
                Task { await self?.markDead() }
                cont.finish()
            }

            do {
                try p.run()
                self.proc = p
            } catch {
                cont.yield(.unknown(raw: "failed to launch claude: \(error)"))
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

    private func markDead() {
        self.proc = nil
        try? self.stdinPipe?.fileHandleForWriting.close()
        self.stdinPipe = nil
    }

    /// Send a user message as stream-json input.
    func send(_ userText: String) throws {
        let payload: [String: Any] = [
            "type": "user",
            "message": [
                "role": "user",
                "content": [["type": "text", "text": userText]]
            ]
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        try writeLine(data)
    }

    /// Approve or deny a pending permission request.
    func answerPermission(toolUseId: String, allow: Bool) throws {
        let payload: [String: Any] = [
            "type": "permission_decision",
            "tool_use_id": toolUseId,
            "decision": allow ? "allow" : "deny"
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        try writeLine(data)
    }

    /// Write one JSON payload + newline to the subprocess. Uses the Swift-throwing
    /// `write(contentsOf:)` API so a broken-pipe doesn't raise an NSException and
    /// take down the whole app. If the process has died, we surface
    /// `ClaudeSessionError.notRunning` and finish the event stream so callers can
    /// restart.
    private func writeLine(_ data: Data) throws {
        guard let pipe = stdinPipe, let p = proc, p.isRunning else {
            shutdownAfterFailure()
            throw ClaudeSessionError.notRunning
        }
        do {
            try pipe.fileHandleForWriting.write(contentsOf: data)
            try pipe.fileHandleForWriting.write(contentsOf: Data("\n".utf8))
        } catch {
            shutdownAfterFailure()
            throw ClaudeSessionError.notRunning
        }
    }

    private func shutdownAfterFailure() {
        if let p = proc, p.isRunning { p.terminate() }
        try? stdinPipe?.fileHandleForWriting.close()
        proc = nil
        stdinPipe = nil
        continuation?.finish()
    }

    func terminate() {
        if let p = proc, p.isRunning { p.terminate() }
        try? stdinPipe?.fileHandleForWriting.close()
        proc = nil
    }

    /// Sends SIGINT to the claude subprocess. Claude Code interprets that as
    /// "abort the current turn but keep the session alive", same as Ctrl-C in
    /// the CLI. Safe no-op if there's no live process.
    func interrupt() {
        guard let p = proc, p.isRunning else { return }
        p.interrupt()
    }
}
