import Foundation

// MARK: - JSON-RPC framing
//
// The MCP server speaks newline-delimited JSON-RPC 2.0 on stdin/stdout.
// Each line is one JSON object. We never log to stdout — diagnostics go to
// stderr so we don't poison the protocol stream.

func log(_ msg: String) {
    FileHandle.standardError.write(Data("\(msg)\n".utf8))
}

func write(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func errorResponse(id: Any?, code: Int, message: String) -> [String: Any] {
    var resp: [String: Any] = [
        "jsonrpc": "2.0",
        "error": ["code": code, "message": message],
    ]
    if let id { resp["id"] = id }
    return resp
}

func successResponse(id: Any?, result: Any) -> [String: Any] {
    var resp: [String: Any] = [
        "jsonrpc": "2.0",
        "result": result,
    ]
    if let id { resp["id"] = id }
    return resp
}

// MARK: - Tools

struct Tool {
    let name: String
    let description: String
    let inputSchema: [String: Any]
    let handler: ([String: Any]) async -> String
}

let kubectlContext = ProcessInfo.processInfo.environment["CLAUDEK8S_CONTEXT"]

func kubectlPath() -> String? {
    let env = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
    for dir in env.split(separator: ":") {
        let candidate = "\(dir)/kubectl"
        if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return nil
}

func runKubectl(_ args: [String]) async -> (String, Int32) {
    guard let kubectl = kubectlPath() else { return ("kubectl not found on PATH", -1) }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: kubectl)
    var fullArgs: [String] = []
    if let ctx = kubectlContext { fullArgs.append(contentsOf: ["--context", ctx]) }
    fullArgs.append(contentsOf: args)
    proc.arguments = fullArgs
    let out = Pipe(); let err = Pipe()
    proc.standardOutput = out
    proc.standardError = err
    do {
        try proc.run()
        proc.waitUntilExit()
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        let combined = (String(data: outData, encoding: .utf8) ?? "")
            + (String(data: errData, encoding: .utf8) ?? "")
        return (combined, proc.terminationStatus)
    } catch {
        return ("\(error)", -1)
    }
}

// MARK: - Tool definitions

let tools: [Tool] = [
    Tool(
        name: "list_unhealthy_pods",
        description: "List all pods that are in a problematic state (CrashLoopBackOff, ImagePullBackOff, ErrImagePull, or phase Failed). Returns name, namespace, restart count, and waiting reason. Use this when the user asks 'what's broken' or 'what's down'.",
        inputSchema: ["type": "object", "properties": [:] as [String: Any], "required": [] as [String]],
        handler: { _ in
            let (text, code) = await runKubectl(["get", "pods", "-A", "-o", "json"])
            if code != 0 { return "kubectl failed (\(code)): \(text)" }
            guard let data = text.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let items = json["items"] as? [[String: Any]]
            else { return "Failed to parse kubectl output." }

            var rows: [String] = []
            for item in items {
                let meta = item["metadata"] as? [String: Any]
                let status = item["status"] as? [String: Any]
                let name = meta?["name"] as? String ?? "?"
                let ns = meta?["namespace"] as? String ?? "default"
                let phase = status?["phase"] as? String ?? ""
                let containerStatuses = status?["containerStatuses"] as? [[String: Any]] ?? []
                var badReason: String?
                var restarts = 0
                for cs in containerStatuses {
                    if let rc = cs["restartCount"] as? Int { restarts += rc }
                    if let state = cs["state"] as? [String: Any],
                       let waiting = state["waiting"] as? [String: Any],
                       let reason = waiting["reason"] as? String,
                       ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull"].contains(reason) {
                        badReason = reason
                    }
                }
                if phase == "Failed" || badReason != nil {
                    let r = badReason ?? "Failed"
                    rows.append("- \(ns)/\(name): \(r), restarts=\(restarts)")
                }
            }
            return rows.isEmpty
                ? "No unhealthy pods. Cluster is clean."
                : "Unhealthy pods (\(rows.count)):\n" + rows.joined(separator: "\n")
        }
    ),

    Tool(
        name: "list_degraded_deployments",
        description: "List deployments where readyReplicas < replicas (not all pods are up). Returns name, namespace, ready/desired counts, and current image. Use this when the user asks why a deployment isn't healthy or what's not running.",
        inputSchema: ["type": "object", "properties": [:] as [String: Any], "required": [] as [String]],
        handler: { _ in
            let (text, code) = await runKubectl(["get", "deployments", "-A", "-o", "json"])
            if code != 0 { return "kubectl failed (\(code)): \(text)" }
            guard let data = text.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let items = json["items"] as? [[String: Any]]
            else { return "Failed to parse kubectl output." }

            var rows: [String] = []
            for item in items {
                let meta = item["metadata"] as? [String: Any]
                let spec = item["spec"] as? [String: Any]
                let status = item["status"] as? [String: Any]
                let name = meta?["name"] as? String ?? "?"
                let ns = meta?["namespace"] as? String ?? "default"
                let desired = (spec?["replicas"] as? Int) ?? (status?["replicas"] as? Int) ?? 0
                let ready = (status?["readyReplicas"] as? Int) ?? 0
                if desired > 0 && ready < desired {
                    let image = ((spec?["template"] as? [String: Any])?["spec"] as? [String: Any])
                        .flatMap { ($0["containers"] as? [[String: Any]])?.first?["image"] as? String } ?? "?"
                    rows.append("- \(ns)/\(name): \(ready)/\(desired) ready, image \(image)")
                }
            }
            return rows.isEmpty
                ? "All deployments are at their desired replica count."
                : "Degraded deployments (\(rows.count)):\n" + rows.joined(separator: "\n")
        }
    ),

    Tool(
        name: "recent_warning_events",
        description: "Fetch recent Warning-level events from the cluster. Use this to find what just went wrong. Optionally narrow by namespace.",
        inputSchema: [
            "type": "object",
            "properties": [
                "namespace": ["type": "string", "description": "Limit to one namespace. Optional."] as [String: Any],
                "limit": ["type": "integer", "description": "Max events to return. Default 30."] as [String: Any],
            ] as [String: Any],
            "required": [] as [String],
        ],
        handler: { args in
            let limit = (args["limit"] as? Int) ?? 30
            var cmd = ["get", "events", "--field-selector", "type=Warning",
                       "-o", "custom-columns=NS:.metadata.namespace,LAST:.lastTimestamp,REASON:.reason,OBJ:.involvedObject.kind/.involvedObject.name,MSG:.message",
                       "--sort-by=.lastTimestamp"]
            if let ns = args["namespace"] as? String, !ns.isEmpty {
                cmd.append(contentsOf: ["-n", ns])
            } else {
                cmd.append("-A")
            }
            let (text, code) = await runKubectl(cmd)
            if code != 0 { return "kubectl failed (\(code)): \(text)" }
            // Show only the trailing `limit` lines (newest events are at the bottom with --sort-by=lastTimestamp).
            let lines = text.split(separator: "\n")
            let tail = lines.suffix(limit + 1).joined(separator: "\n")
            return tail.isEmpty ? "No warning events." : String(tail)
        }
    ),

    Tool(
        name: "get_pod_logs",
        description: "Fetch the most recent logs for a pod. Use this when investigating why a specific pod is failing.",
        inputSchema: [
            "type": "object",
            "properties": [
                "name": ["type": "string", "description": "Pod name."] as [String: Any],
                "namespace": ["type": "string", "description": "Namespace. Defaults to 'default'."] as [String: Any],
                "tail": ["type": "integer", "description": "Number of lines from the end. Default 200."] as [String: Any],
            ] as [String: Any],
            "required": ["name"] as [String],
        ],
        handler: { args in
            guard let name = args["name"] as? String, !name.isEmpty else { return "name is required" }
            let ns = (args["namespace"] as? String) ?? "default"
            let tail = (args["tail"] as? Int) ?? 200
            let (text, code) = await runKubectl([
                "logs", name, "-n", ns,
                "--tail=\(tail)", "--all-containers=true",
            ])
            if code != 0 { return "kubectl failed (\(code)): \(text)" }
            return text.isEmpty ? "(no log output)" : text
        }
    ),
]

// MARK: - Routing

func handle(_ obj: [String: Any]) async -> [String: Any]? {
    let id = obj["id"]
    let method = obj["method"] as? String ?? ""
    let params = (obj["params"] as? [String: Any]) ?? [:]

    switch method {
    case "initialize":
        return successResponse(id: id, result: [
            "protocolVersion": "2024-11-05",
            "capabilities": ["tools": [String: Any]()],
            "serverInfo": [
                "name": "helmsman",
                "version": "0.1.0",
            ],
        ])

    case "notifications/initialized":
        return nil  // notifications don't get a response

    case "tools/list":
        let toolList: [[String: Any]] = tools.map {
            ["name": $0.name, "description": $0.description, "inputSchema": $0.inputSchema]
        }
        return successResponse(id: id, result: ["tools": toolList])

    case "tools/call":
        guard let name = params["name"] as? String else {
            return errorResponse(id: id, code: -32602, message: "missing tool name")
        }
        let args = (params["arguments"] as? [String: Any]) ?? [:]
        guard let tool = tools.first(where: { $0.name == name }) else {
            return errorResponse(id: id, code: -32601, message: "unknown tool: \(name)")
        }
        let text = await tool.handler(args)
        return successResponse(id: id, result: [
            "content": [["type": "text", "text": text]],
        ])

    default:
        if id == nil {
            // Unknown notification — silently ignore.
            return nil
        }
        return errorResponse(id: id, code: -32601, message: "method not found: \(method)")
    }
}

// MARK: - stdin loop

log("helmsman MCP server up (\(tools.count) tools)")

while let line = readLine() {
    guard !line.isEmpty,
          let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { continue }

    // Process serially so responses don't interleave on stdout.
    let sem = DispatchSemaphore(value: 0)
    Task {
        if let response = await handle(obj) {
            write(response)
        }
        sem.signal()
    }
    sem.wait()
}
