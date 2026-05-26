import Foundation

enum ProcessError: Error, CustomStringConvertible {
    case nonZeroExit(code: Int32, stderr: String)
    case launchFailed(underlying: Error)
    case stdoutClosed

    var description: String {
        switch self {
        case .nonZeroExit(let code, let stderr):
            return "process exited with code \(code): \(stderr)"
        case .launchFailed(let err):
            return "process launch failed: \(err)"
        case .stdoutClosed:
            return "process stdout closed unexpectedly"
        }
    }
}

/// Run a one-shot subprocess and collect its full stdout. Throws if exit != 0.
func runProcess(_ launchPath: String, args: [String], env: [String: String]? = nil) async throws -> Data {
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchPath)
        proc.arguments = args
        if let env { proc.environment = env }

        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        proc.terminationHandler = { p in
            let out = outPipe.fileHandleForReading.readDataToEndOfFile()
            let err = errPipe.fileHandleForReading.readDataToEndOfFile()
            if p.terminationStatus == 0 {
                cont.resume(returning: out)
            } else {
                let errStr = String(data: err, encoding: .utf8) ?? ""
                cont.resume(throwing: ProcessError.nonZeroExit(code: p.terminationStatus, stderr: errStr))
            }
        }

        do {
            try proc.run()
        } catch {
            cont.resume(throwing: ProcessError.launchFailed(underlying: error))
        }
    }
}

/// Resolve a binary on PATH (e.g. "kubectl", "claude") to an absolute path.
func resolveBinary(_ name: String) -> String? {
    let env = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
    for dir in env.split(separator: ":") {
        let candidate = "\(dir)/\(name)"
        if FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
    }
    return nil
}
